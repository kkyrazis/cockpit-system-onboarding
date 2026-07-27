#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_NAME="flightctl-onboarding-rpm-builder"
IMAGE_TAG="latest"
IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"

build_image() {
    echo "Building container image ${IMAGE}..."
    podman build -t "${IMAGE}" -f "${SCRIPT_DIR}/Containerfile.packit_builder" "${SCRIPT_DIR}"
}

ensure_image() {
    if ! podman image exists "${IMAGE}" 2>/dev/null; then
        build_image
    fi
}

run_build() {
    local git_mounts=()

    # In a worktree, .git is a file pointing to the main repo's .git directory.
    # Mount the real git dir into the container so git operations work.
    if [[ -f "${REPO_ROOT}/.git" ]]; then
        local git_dir
        git_dir="$(git -C "${REPO_ROOT}" rev-parse --git-dir)"
        git_dir="$(cd "${REPO_ROOT}" && realpath "${git_dir}")"
        local common_dir
        common_dir="$(git -C "${REPO_ROOT}" rev-parse --git-common-dir)"
        common_dir="$(cd "${REPO_ROOT}" && realpath "${common_dir}")"
        git_mounts=(-v "${git_dir}:${git_dir}:z" -v "${common_dir}:${common_dir}:z")
    fi

    rm -rf "${REPO_ROOT}/rpmbuild"
    rm -f "${REPO_ROOT}"/flightctl-onboarding-*.tar.xz
    rm -f "${REPO_ROOT}/flightctl-onboarding.spec"

    local output_dir="${REPO_ROOT}/bin/rpm"
    mkdir -p "${output_dir}"

    echo "Building RPMs in container..."
    podman run --rm \
        -v "${REPO_ROOT}:/src:ro" \
        -v "${output_dir}:/output" \
        ${git_mounts[@]+"${git_mounts[@]}"} \
        "${IMAGE}" \
        bash -c '
            mkdir -p /work
            cp -a /src/. /work/
            cd /work
            git config --global --add safe.directory /work
            packit build locally 2>&1
            status=$?
            if [ $status -ne 0 ]; then
                echo "ERROR: packit build failed with status $status" >&2
                exit $status
            fi
            cp /work/noarch/*.rpm /output/ 2>/dev/null || :
        '
}

collect_rpms() {
    local output_dir="${REPO_ROOT}/bin/rpm"
    mkdir -p "${output_dir}"

    echo "Collecting RPMs..."
    find "${REPO_ROOT}" -maxdepth 3 -name '*.rpm' \
        -not -path "${output_dir}/*" \
        -not -path '*/node_modules/*' \
        -exec mv {} "${output_dir}/" \;

    echo "RPMs available in bin/rpm/:"
    ls -1 "${output_dir}"/*.rpm 2>/dev/null || echo "  (none found)"
}

cleanup() {
    rm -rf "${REPO_ROOT}/rpmbuild" "${REPO_ROOT}/noarch" "${REPO_ROOT}/x86_64" "${REPO_ROOT}/aarch64"
    rm -f "${REPO_ROOT}"/*.src.rpm
}

usage() {
    echo "Usage: $(basename "$0") [OPTIONS]"
    echo ""
    echo "Build RPMs using packit inside a container."
    echo ""
    echo "Options:"
    echo "  --rebuild-image  Force rebuild the container image"
    echo "  -h, --help       Show this help"
}

REBUILD_IMAGE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rebuild-image)
            REBUILD_IMAGE=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ "${REBUILD_IMAGE}" == "true" ]]; then
    build_image
else
    ensure_image
fi

trap cleanup EXIT
run_build
collect_rpms

echo "Done."
