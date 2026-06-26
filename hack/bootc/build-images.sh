#!/usr/bin/env bash
# Build raw disk images for flashing Raspberry Pi SD cards.
#
# Builds bootc container images from the Containerfiles, then converts them
# to raw disk images via bootc-image-builder (BIB). Designed for native
# aarch64 hosts (e.g., Apple Silicon Mac Mini) where no cross-arch emulation
# is needed.
#
# Prerequisites:
#   - podman (with podman machine running on macOS)
#   - cockpit-system-onboarding RPM built (run `make rpm` first, or let this script do it)
#
# Usage:
#   hack/bootc/build-images.sh [--containers-only]
#
# Options:
#   --containers-only   Build container images only (skip disk image conversion).
#
# Output:
#   hack/bootc/output/*.raw  — raw disk images, flash with:
#     sudo dd if=output/<image>.raw of=/dev/sdX bs=4M status=progress conv=fsync
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/output"
CACHE_DIR="${HOME}/.cache/bootc-image-builder"
CONTAINERS_ONLY=false
BIB_IMAGE="quay.io/centos-bootc/bootc-image-builder:latest"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --containers-only) CONTAINERS_ONLY=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

IMAGES=(
    "server"
    "headless-wifi"
    "headless-ethernet"
    "headful-ethernet"
)

# On macOS, podman runs through a VM and doesn't need sudo.
# On Linux, BIB needs root for privileged container operations.
if [[ "$(uname -s)" == "Darwin" ]]; then
    SUDO_PODMAN="podman"
else
    SUDO_PODMAN="sudo podman"
fi

# ---------------------------------------------------------------------------
# RPM + CA
# ---------------------------------------------------------------------------

build_rpm() {
    local rpm
    rpm=$(find "$REPO_ROOT" -maxdepth 1 -name 'cockpit-system-onboarding-*.noarch.rpm' -print -quit 2>/dev/null)
    if [ -z "$rpm" ]; then
        echo "=== No RPM found, building... ==="
        if [[ "$(uname -s)" == "Darwin" ]]; then
            # macOS has no rpmbuild — build inside a Fedora container
            echo "  (building RPM in Fedora container)"
            podman run --rm \
                -v "$REPO_ROOT":/src:Z \
                -w /src \
                registry.fedoraproject.org/fedora:43 \
                bash -c '
                    dnf install -y \
                        git make rpm-build \
                        nodejs npm \
                        gettext libappstream-glib systemd-rpm-macros
                    git config --global --add safe.directory /src
                    make rpm
                '
        else
            (cd "$REPO_ROOT" && make rpm)
        fi
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
# Container builds
# ---------------------------------------------------------------------------

build_containers() {
    echo ""
    echo "=== Building container images ==="
    for image in "${IMAGES[@]}"; do
        echo ""
        echo "--- Building onboarding-${image} ---"
        $SUDO_PODMAN build \
            -t "onboarding-${image}:latest" \
            -f "$SCRIPT_DIR/Containerfile.${image}" \
            "$SCRIPT_DIR"
    done
}

# ---------------------------------------------------------------------------
# Disk image conversion via bootc-image-builder
# ---------------------------------------------------------------------------

convert_to_raw() {
    local role="$1"
    local role_output="$OUTPUT_DIR/$role"

    echo ""
    echo "--- Converting onboarding-${role} to raw disk image ---"

    mkdir -p "$role_output" "$CACHE_DIR/osbuild" "$CACHE_DIR/dnf"

    $SUDO_PODMAN run --rm \
        --privileged \
        --pull=newer \
        --security-opt label=type:unconfined_t \
        -v "$role_output":/output \
        -v "$CACHE_DIR/osbuild":/var/cache/osbuild \
        -v "$CACHE_DIR/dnf":/var/cache/dnf \
        -v /var/lib/containers/storage:/var/lib/containers/storage \
        "$BIB_IMAGE" \
        build \
        --type raw \
        --local \
        "localhost/onboarding-${role}:latest"

    # BIB writes to /output/image/disk.raw — move to our naming convention
    local raw_file=""
    for candidate in "$role_output/image/disk.raw" "$role_output/raw/disk.raw" "$role_output/disk.raw"; do
        if [[ -f "$candidate" ]]; then
            raw_file="$candidate"
            break
        fi
    done

    if [[ -n "$raw_file" ]]; then
        mv "$raw_file" "$OUTPUT_DIR/onboarding-${role}.raw"
        rm -rf "$role_output"
    else
        echo "ERROR: BIB did not produce a raw image for ${role}" >&2
        echo "  Check $role_output for output files" >&2
        return 1
    fi

    # Fix ownership when running with sudo on Linux
    if [[ "$(uname -s)" != "Darwin" ]]; then
        sudo chown "${USER}:$(id -gn)" "$OUTPUT_DIR/onboarding-${role}.raw"
    fi

    echo "  Created: output/onboarding-${role}.raw"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    build_rpm
    generate_ca

    build_containers

    if [ "$CONTAINERS_ONLY" = true ]; then
        rm -f "$SCRIPT_DIR"/cockpit-system-onboarding-*.noarch.rpm
        echo ""
        echo "=== Container images built (--containers-only, skipping disk images) ==="
        for image in "${IMAGES[@]}"; do
            echo "  onboarding-${image}:latest"
        done
        exit 0
    fi

    echo ""
    echo "=== Converting containers to raw disk images ==="
    mkdir -p "$OUTPUT_DIR"

    for image in "${IMAGES[@]}"; do
        convert_to_raw "$image"
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
