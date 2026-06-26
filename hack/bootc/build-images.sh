#!/usr/bin/env bash
# Build raw disk images for flashing Raspberry Pi SD cards.
#
# Downloads a Fedora Server aarch64 base image, then provisions each role
# (server, headless-wifi, headless-ethernet, headful-ethernet) by installing
# packages and config files directly onto the filesystem. No VMs, no bootc,
# no cross-arch emulation overhead — dnf runs natively on x86_64 and only
# RPM scriptlets execute under QEMU user-mode.
#
# Prerequisites:
#   - qemu-user-static (for aarch64 RPM scriptlets via binfmt_misc)
#   - cockpit-system-onboarding RPM built (run `make rpm` first, or let this script do it)
#   - Internet access (to download base image + packages on first run; cached afterward)
#
# Optional:
#   - fedora-arm-image-installer (rewrites boot partition for Raspberry Pi)
#
# Usage:
#   hack/bootc/build-images.sh [--containers-only] [--arch <arch>]
#
# Options:
#   --containers-only   Build container images only (no disk images).
#   --arch <arch>       Target architecture (default: aarch64).
#
# Output:
#   hack/bootc/output/*.raw  — raw disk images, flash with:
#     sudo dd if=output/<image>.raw of=/dev/sdX bs=4M status=progress conv=fsync
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/output"
CONTAINERS_ONLY=false
TARGET_ARCH="aarch64"
FEDORA_VERSION=43
FEDORA_BUILD="${FEDORA_VERSION}-1.6"
CACHE_DIR="${HOME}/.cache/fedora-sd-images"
BASE_IMAGE_NAME="Fedora-Server-Host-Generic-${FEDORA_BUILD}.${TARGET_ARCH}.raw.xz"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --containers-only) CONTAINERS_ONLY=true; shift ;;
        --arch) TARGET_ARCH="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

case "$TARGET_ARCH" in
    aarch64) PODMAN_PLATFORM="linux/arm64" ;;
    x86_64)  PODMAN_PLATFORM="linux/amd64" ;;
    *)       PODMAN_PLATFORM="linux/${TARGET_ARCH}" ;;
esac

BASE_IMAGE_NAME="Fedora-Server-Host-Generic-${FEDORA_BUILD}.${TARGET_ARCH}.raw.xz"
BASE_IMAGE_URL="https://dl.fedoraproject.org/pub/fedora/linux/releases/${FEDORA_VERSION}/Server/${TARGET_ARCH}/images/${BASE_IMAGE_NAME}"

IMAGES=(
    "server"
    "headless-wifi"
    "headless-ethernet"
    "headful-ethernet"
)

# Packages common to all agent roles (wifi, ethernet, headful)
AGENT_COMMON_PKGS=(
    cockpit cockpit-ws cockpit-bridge
    NetworkManager NetworkManager-wifi wpa_supplicant
    hostapd dnsmasq jq chrony iw wireless-regdb linux-firmware
    openssh-server
    flightctl-agent flightctl-cli
)

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

check_prerequisites() {
    local missing=()
    if ! ls /proc/sys/fs/binfmt_misc/qemu-aarch64 &>/dev/null; then
        missing+=("qemu-user-static (binfmt not registered for aarch64)")
    fi
    for cmd in xzcat curl losetup partprobe; do
        if ! command -v "$cmd" &>/dev/null; then
            missing+=("$cmd")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "ERROR: Missing prerequisites:" >&2
        for m in "${missing[@]}"; do echo "  - $m" >&2; done
        echo "" >&2
        echo "Install with: sudo dnf install qemu-user-static util-linux parted xz curl" >&2
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# RPM + CA (unchanged from original)
# ---------------------------------------------------------------------------

build_rpm() {
    local rpm
    rpm=$(find "$REPO_ROOT" -maxdepth 1 -name 'cockpit-system-onboarding-*.noarch.rpm' -print -quit 2>/dev/null)
    if [ -z "$rpm" ]; then
        echo "=== No RPM found, building... ==="
        (cd "$REPO_ROOT" && make rpm)
        rpm=$(find "$REPO_ROOT" -maxdepth 1 -name 'cockpit-system-onboarding-*.noarch.rpm' -print -quit)
    fi
    if [ -z "$rpm" ]; then
        echo "ERROR: Could not find or build cockpit-system-onboarding RPM." >&2
        exit 1
    fi
    echo "=== Using RPM: $(basename "$rpm") ==="
    cp "$rpm" "$SCRIPT_DIR/"
    RPM_FILE="$SCRIPT_DIR/$(basename "$rpm")"
}

generate_ca() {
    local pki_dir="$SCRIPT_DIR/config/pki"
    mkdir -p "$pki_dir"
    if [ -f "$pki_dir/ca.crt" ] && [ -f "$pki_dir/ca.key" ]; then
        echo ""
        echo "=== Reusing existing CA at config/pki/ ==="
        return
    fi
    echo ""
    echo "=== Generating root CA (ECDSA P-256, 10yr) ==="
    openssl ecparam -name prime256v1 -genkey -noout -out "$pki_dir/ca.key"
    chmod 600 "$pki_dir/ca.key"
    openssl req -new -x509 -sha256 \
        -key "$pki_dir/ca.key" \
        -out "$pki_dir/ca.crt" \
        -days 3650 \
        -subj "/CN=flightctl-test-ca" \
        -addext "basicConstraints = critical, CA:TRUE" \
        -addext "keyUsage = critical, digitalSignature, keyCertSign, cRLSign"
    echo "  Generated: config/pki/ca.crt + ca.key"
}

# ---------------------------------------------------------------------------
# Container builds (optional, behind --containers-only)
# ---------------------------------------------------------------------------

build_containers() {
    echo ""
    echo "=== Building container images ==="
    for image in "${IMAGES[@]}"; do
        echo ""
        echo "--- Building onboarding-${image} ---"
        sudo podman build \
            --platform "$PODMAN_PLATFORM" \
            -t "onboarding-${image}:latest" \
            -f "$SCRIPT_DIR/Containerfile.${image}" \
            "$SCRIPT_DIR"
    done
}

# ---------------------------------------------------------------------------
# Base image download
# ---------------------------------------------------------------------------

download_base_image() {
    mkdir -p "$CACHE_DIR"
    if [[ -f "$CACHE_DIR/$BASE_IMAGE_NAME" ]]; then
        echo "  Using cached base image: $CACHE_DIR/$BASE_IMAGE_NAME"
        return
    fi
    echo "  Downloading Fedora Server ${FEDORA_VERSION} ${TARGET_ARCH} raw image..."
    curl -L -o "$CACHE_DIR/$BASE_IMAGE_NAME" "$BASE_IMAGE_URL"
    echo "  Download complete."
}

# ---------------------------------------------------------------------------
# Image provisioning
# ---------------------------------------------------------------------------

cleanup_mounts() {
    local mountpoint="$1"
    local loopdev="$2"
    sync
    sudo umount "$mountpoint/dev/pts" 2>/dev/null || true
    sudo umount "$mountpoint/dev" 2>/dev/null || true
    sudo umount "$mountpoint/proc" 2>/dev/null || true
    sudo umount "$mountpoint/sys" 2>/dev/null || true
    sudo umount "$mountpoint" 2>/dev/null || true
    if [[ -n "${LVM_VG:-}" ]]; then
        sudo vgchange -an "$LVM_VG" 2>/dev/null || true
    fi
    if [[ -n "$loopdev" ]]; then
        sudo losetup -d "$loopdev" 2>/dev/null || true
    fi
}

setup_image() {
    local role="$1"
    local raw_file="$OUTPUT_DIR/onboarding-${role}.raw"

    echo "  Decompressing base image..."
    xzcat "$CACHE_DIR/$BASE_IMAGE_NAME" > "$raw_file"

    # Grow the image to accommodate additional packages.
    # The base image decompresses to ~10 GiB; sizes must be larger than that.
    local target_size="14G"
    if [[ "$role" == "headful-ethernet" ]]; then
        target_size="18G"
    fi
    local current_size
    current_size=$(stat --format=%s "$raw_file")
    local target_bytes
    target_bytes=$(numfmt --from=iec "$target_size")
    if (( current_size < target_bytes )); then
        truncate -s "$target_size" "$raw_file"
    fi

    echo "  Setting up loop device..."
    LOOPDEV=$(sudo losetup --find --show --partscan "$raw_file")
    sudo partprobe "$LOOPDEV"
    sleep 1
    echo "  Loop device: $LOOPDEV"

    # The root partition is the last partition (p3 in Fedora Server images).
    # Find it by taking the highest-numbered partition device.
    local root_part=""
    root_part=$(ls "${LOOPDEV}p"* 2>/dev/null | sort -V | tail -1)
    if [[ -z "$root_part" ]]; then
        echo "ERROR: Could not find partitions on $LOOPDEV" >&2
        sudo losetup -d "$LOOPDEV"
        return 1
    fi
    ROOT_PART="$root_part"
    local part_num
    part_num=$(echo "$ROOT_PART" | grep -oP 'p\K[0-9]+$')
    echo "  Root partition: $ROOT_PART (partition $part_num)"

    # Grow the root partition to fill available space
    sudo parted -s "$LOOPDEV" resizepart "$part_num" 100%
    sudo partprobe "$LOOPDEV"
    sleep 1

    local part_type
    part_type=$(sudo blkid -s TYPE -o value "$ROOT_PART" 2>/dev/null || echo "")

    LVM_VG=""
    if [[ "$part_type" == "LVM2_member" ]]; then
        echo "  Detected LVM — activating volume group..."
        sudo pvresize "$ROOT_PART"
        LVM_VG=$(sudo pvs --noheadings -o vg_name "$ROOT_PART" 2>/dev/null | tr -d ' ')
        sudo vgchange -ay "$LVM_VG"
        MOUNT_DEV=$(sudo lvs --noheadings -o lv_path "$LVM_VG" 2>/dev/null | grep -i root | tr -d ' ' | head -1)
        if [[ -z "$MOUNT_DEV" ]]; then
            MOUNT_DEV=$(sudo lvs --noheadings -o lv_path "$LVM_VG" 2>/dev/null | tr -d ' ' | head -1)
        fi
        sudo lvextend -l +100%FREE "$MOUNT_DEV" 2>/dev/null || true
        echo "  LVM root: $MOUNT_DEV (VG: $LVM_VG)"
    else
        MOUNT_DEV="$ROOT_PART"
    fi
    echo "  Partition resized."
}

mount_image() {
    MOUNTPOINT=$(mktemp -d /tmp/sd-provision.XXXXXX)
    sudo mount "$MOUNT_DEV" "$MOUNTPOINT"

    # Grow the filesystem now that it's mounted (xfs_growfs requires this)
    local fstype
    fstype=$(sudo blkid -s TYPE -o value "$MOUNT_DEV" 2>/dev/null || echo "")
    case "$fstype" in
        ext4)   sudo resize2fs "$MOUNT_DEV" 2>/dev/null || true ;;
        xfs)    sudo xfs_growfs "$MOUNTPOINT" 2>/dev/null || true ;;
        btrfs)  sudo btrfs filesystem resize max "$MOUNTPOINT" 2>/dev/null || true ;;
    esac
    echo "  Filesystem resized."

    sudo mount --bind /dev "$MOUNTPOINT/dev"
    sudo mount --bind /dev/pts "$MOUNTPOINT/dev/pts"
    sudo mount --bind /proc "$MOUNTPOINT/proc"
    sudo mount --bind /sys "$MOUNTPOINT/sys"
    sudo cp /etc/resolv.conf "$MOUNTPOINT/etc/resolv.conf"
    echo "  Mounted at $MOUNTPOINT"
}

install_repos() {
    echo "  Adding flightctl package repos..."
    sudo curl -fsSLo "$MOUNTPOINT/etc/yum.repos.d/flightctl-fedora.repo" \
        "https://rpm.flightctl.io/flightctl-fedora.repo"
    sudo curl -fsSLo "$MOUNTPOINT/etc/yum.repos.d/flightctl-dev.repo" \
        "https://copr.fedorainfracloud.org/coprs/g/redhat-et/flightctl-dev/repo/fedora-${FEDORA_VERSION}/group_redhat-et-flightctl-dev-fedora-${FEDORA_VERSION}.repo"
}

install_packages() {
    local role="$1"
    local pkgs=()

    case "$role" in
        server)
            pkgs=(flightctl-services flightctl-cli)
            ;;
        headless-wifi)
            pkgs=("${AGENT_COMMON_PKGS[@]}" kernel-modules-internal kernel-modules-extra)
            ;;
        headless-ethernet)
            pkgs=("${AGENT_COMMON_PKGS[@]}")
            ;;
        headful-ethernet)
            pkgs=("${AGENT_COMMON_PKGS[@]}"
                xfce4-session xfce4-panel xfce4-settings xfce4-terminal
                xfwm4 xfdesktop thunar lightdm firefox)
            ;;
    esac

    echo "  Installing packages (this may take a few minutes)..."
    sudo dnf --installroot="$MOUNTPOINT" \
        --releasever="$FEDORA_VERSION" \
        --setopt=reposdir="$MOUNTPOINT/etc/yum.repos.d" \
        --forcearch="$TARGET_ARCH" \
        install -y "${pkgs[@]}"

    # Install the local cockpit-system-onboarding RPM (agent roles only)
    if [[ "$role" != "server" ]]; then
        sudo cp "$RPM_FILE" "$MOUNTPOINT/tmp/"
        sudo dnf --installroot="$MOUNTPOINT" \
            --releasever="$FEDORA_VERSION" \
            --forcearch="$TARGET_ARCH" \
            install -y "$MOUNTPOINT/tmp/$(basename "$RPM_FILE")"
        sudo rm -f "$MOUNTPOINT/tmp/"cockpit-system-onboarding-*.rpm
    fi
}

configure_role() {
    local role="$1"
    local config_dir="$SCRIPT_DIR/config"

    case "$role" in
        server)
            sudo install -Dm644 "$config_dir/pki/ca.crt" "$MOUNTPOINT/etc/flightctl/pki/ca.crt"
            sudo install -Dm600 "$config_dir/pki/ca.key" "$MOUNTPOINT/etc/flightctl/pki/ca.key"
            sudo install -Dm644 "$config_dir/service-config.yaml" "$MOUNTPOINT/etc/flightctl/service-config.yaml"
            sudo install -Dm600 "$config_dir/server-ethernet.nmconnection" \
                "$MOUNTPOINT/etc/NetworkManager/system-connections/server-ethernet.nmconnection"
            sudo install -Dm755 "$config_dir/flightctl-setup-admin.sh" \
                "$MOUNTPOINT/usr/local/bin/flightctl-setup-admin.sh"
            sudo install -Dm644 "$config_dir/flightctl-setup-admin.service" \
                "$MOUNTPOINT/etc/systemd/system/flightctl-setup-admin.service"
            echo "flightctl.local" | sudo tee "$MOUNTPOINT/etc/hostname" > /dev/null
            ;;
        headless-wifi)
            sudo install -Dm644 "$config_dir/config-wifi.json" \
                "$MOUNTPOINT/etc/cockpit/system-onboarding/config.json"
            sudo install -Dm644 "$config_dir/pki/ca.crt" "$MOUNTPOINT/etc/flightctl/certs/ca.crt"
            ;;
        headless-ethernet|headful-ethernet)
            sudo install -Dm644 "$config_dir/config-ethernet.json" \
                "$MOUNTPOINT/etc/cockpit/system-onboarding/config.json"
            sudo install -Dm644 "$config_dir/pki/ca.crt" "$MOUNTPOINT/etc/flightctl/certs/ca.crt"
            ;;
    esac
}

enable_service() {
    local unit="$1"
    local wants_dir="$MOUNTPOINT/etc/systemd/system/multi-user.target.wants"
    sudo mkdir -p "$wants_dir"

    # Find the unit file in the image
    local unit_path=""
    for search_dir in usr/lib/systemd/system etc/systemd/system lib/systemd/system; do
        if [[ -f "$MOUNTPOINT/$search_dir/$unit" ]]; then
            unit_path="/$search_dir/$unit"
            break
        fi
    done
    if [[ -z "$unit_path" ]]; then
        echo "  WARN: unit $unit not found, skipping enable" >&2
        return
    fi
    sudo ln -sf "$unit_path" "$wants_dir/$unit"
}

enable_services() {
    local role="$1"

    case "$role" in
        server)
            enable_service flightctl.target
            enable_service sshd.service
            enable_service flightctl-setup-admin.service
            ;;
        headless-wifi|headless-ethernet)
            enable_service cockpit.socket
            enable_service sshd.service
            enable_service cockpit-system-onboarding-setup.service
            ;;
        headful-ethernet)
            enable_service cockpit.socket
            enable_service sshd.service
            enable_service cockpit-system-onboarding-setup.service
            enable_service lightdm.service
            sudo ln -sf /usr/lib/systemd/system/graphical.target \
                "$MOUNTPOINT/etc/systemd/system/default.target"
            ;;
    esac
}

create_user() {
    if sudo grep -q '^testadmin:' "$MOUNTPOINT/etc/passwd" 2>/dev/null; then
        return
    fi

    local uid=1001
    local gid=1001
    local pw_hash
    pw_hash=$(openssl passwd -6 testadmin)

    echo "testadmin:x:${uid}:${gid}::/home/testadmin:/bin/bash" | sudo tee -a "$MOUNTPOINT/etc/passwd" > /dev/null
    echo "testadmin:${pw_hash}:19900:0:99999:7:::" | sudo tee -a "$MOUNTPOINT/etc/shadow" > /dev/null
    echo "testadmin:x:${gid}:" | sudo tee -a "$MOUNTPOINT/etc/group" > /dev/null
    sudo sed -i 's/^wheel:\(.*\)/wheel:\1,testadmin/' "$MOUNTPOINT/etc/group"
    # Clean up double comma if wheel had no members
    sudo sed -i 's/wheel:\(.*\),,/wheel:\1,/' "$MOUNTPOINT/etc/group"

    echo "testadmin ALL=(ALL) NOPASSWD: ALL" | sudo tee "$MOUNTPOINT/etc/sudoers.d/testadmin" > /dev/null
    sudo chmod 440 "$MOUNTPOINT/etc/sudoers.d/testadmin"

    sudo mkdir -p "$MOUNTPOINT/home/testadmin/.ssh"
    sudo chmod 700 "$MOUNTPOINT/home/testadmin/.ssh"
    sudo chown "${uid}:${gid}" "$MOUNTPOINT/home/testadmin"
    sudo chown -R "${uid}:${gid}" "$MOUNTPOINT/home/testadmin/.ssh"
}

provision_image() {
    local role="$1"
    LOOPDEV=""
    MOUNTPOINT=""
    ROOT_PART=""
    MOUNT_DEV=""
    LVM_VG=""

    echo ""
    echo "--- Provisioning onboarding-${role} ---"

    trap 'cleanup_mounts "${MOUNTPOINT:-}" "${LOOPDEV:-}"' EXIT

    setup_image "$role"
    mount_image
    install_repos
    install_packages "$role"
    configure_role "$role"
    enable_services "$role"
    create_user

    cleanup_mounts "$MOUNTPOINT" "$LOOPDEV"
    trap - EXIT
    LOOPDEV=""
    MOUNTPOINT=""

    echo "  Created: output/onboarding-${role}.raw"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    check_prerequisites
    build_rpm
    generate_ca

    if [ "$CONTAINERS_ONLY" = true ]; then
        build_containers
        rm -f "$SCRIPT_DIR"/cockpit-system-onboarding-*.noarch.rpm
        echo ""
        echo "=== Container images built (--containers-only, skipping disk images) ==="
        for image in "${IMAGES[@]}"; do
            echo "  onboarding-${image}:latest"
        done
        exit 0
    fi

    echo ""
    echo "=== Creating SD card images (${TARGET_ARCH}) ==="
    download_base_image
    mkdir -p "$OUTPUT_DIR"

    for image in "${IMAGES[@]}"; do
        provision_image "$image"
    done

    rm -f "$SCRIPT_DIR"/cockpit-system-onboarding-*.noarch.rpm

    echo ""
    echo "=========================================="
    echo " Build Complete"
    echo "=========================================="
    echo ""
    echo "Disk images:"
    for image in "${IMAGES[@]}"; do
        if [ -f "$OUTPUT_DIR/onboarding-${image}.raw" ]; then
            SIZE=$(du -h "$OUTPUT_DIR/onboarding-${image}.raw" | cut -f1)
            echo "  $OUTPUT_DIR/onboarding-${image}.raw  ($SIZE)"
        fi
    done
    echo ""
    echo "Flash to SD card:"
    echo "  sudo dd if=output/onboarding-<image>.raw of=/dev/sdX bs=4M status=progress conv=fsync"
    echo ""
    echo "Identify your SD card device with 'lsblk' before flashing."
}

main
