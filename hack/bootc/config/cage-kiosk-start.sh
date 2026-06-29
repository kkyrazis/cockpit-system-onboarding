#!/bin/bash
# Find the vc4-drm card (the one with HDMI outputs) and tell wlroots to use it.
# Pi 4 exposes both v3d (3D-only) and vc4 (display) as separate DRM cards;
# wlroots may pick v3d first which has no connectors.
for card in /sys/class/drm/card*; do
    card_name=$(basename "$card")
    [[ "$card_name" == card*-* ]] && continue
    driver=$(basename "$(readlink "$card/device/driver")" 2>/dev/null)
    if [[ "$driver" == "vc4-drm" ]]; then
        export WLR_DRM_DEVICES="/dev/dri/$card_name"
        break
    fi
done

exec /usr/bin/cage -- /usr/bin/firefox --kiosk https://localhost:9090
