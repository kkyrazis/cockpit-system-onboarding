#!/bin/bash
# Pre-pull all container images referenced by installed quadlet files into
# local containers-storage so flightctl services work fully air-gapped.
set -euo pipefail

QUADLET_DIR="/usr/share/containers/systemd"

if [ ! -d "$QUADLET_DIR" ]; then
    echo "No quadlet directory at $QUADLET_DIR — skipping image preload"
    exit 0
fi

images=$(grep -h '^Image=' "$QUADLET_DIR"/*.container 2>/dev/null \
    | sed 's/^Image=//' | sort -u)

if [ -z "$images" ]; then
    echo "No container images found in quadlet files — skipping"
    exit 0
fi

count=$(echo "$images" | wc -l)
echo "Pre-pulling $count container images from quadlet definitions..."

i=0
for img in $images; do
    i=$((i + 1))
    echo "  [$i/$count] $img"
    skopeo copy "docker://$img" "containers-storage:$img"
done

echo "All $count images pre-loaded into containers-storage"
