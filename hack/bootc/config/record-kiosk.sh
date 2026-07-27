#!/usr/bin/env bash
# Record the kiosk screen. Run as testadmin over SSH.
# Press Ctrl+C to stop. Output: /tmp/kiosk-recording.mp4
set -euo pipefail

OUTPUT="/tmp/kiosk-recording.mp4"
KIOSK_USER="kiosk"
KIOSK_UID="$(id -u ${KIOSK_USER})"

echo "Recording kiosk to ${OUTPUT}"
echo "Press Ctrl+C to stop."

sudo -u "${KIOSK_USER}" \
    WAYLAND_DISPLAY=wayland-0 \
    XDG_RUNTIME_DIR="/run/user/${KIOSK_UID}" \
    wf-recorder -r 15 -c h264_v4l2m2m -f "${OUTPUT}" \
    || true

echo "Saved to ${OUTPUT}"
echo "Copy with: scp testadmin@<this-ip>:${OUTPUT} ."
