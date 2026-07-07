#!/bin/bash
# flightctl-enroll.sh - Enroll device with Flight Control
#
# Cockpit System Onboarding enrollment script.
# Reads credentials from ENROLLMENT_CREDENTIALS_JSON and endpoint from
# ENROLLMENT_ENDPOINT environment variables.
#
# Expected credential fields (from credentialsSchema, oneOf):
#   Variant 1 - Token auth:
#     token (required) - Flight Control API token
#   Variant 2 - Username & password:
#     username (required) - Flight Control username
#     password (required) - Flight Control password
#
# Modes:
#   ENROLLMENT_USE_EXISTING=false (default): Login, request certificate, install agent config,
#     write label/proxy drop-ins. Restart agent when the onboarding gate allows it.
#   ENROLLMENT_USE_EXISTING=true: Skip login and certificate steps. Write label/proxy drop-ins
#     and restart agent when the onboarding gate allows it.
#
# Progress protocol — the UI parses stdout lines by prefix:
#   STEP:  A new step is starting (UI shows spinner)
#   OK:    The current step succeeded (UI shows checkmark)
#   ERROR: The current step failed (UI shows error icon)
#   INFO:  Informational message (UI shows info icon)
#   DEVICE_URL: Device management URL (captured for "View in UI" link)
#   (unprefixed lines are captured but not rendered)
#
# See: specs/001-system-onboarding/contracts/enrollment-api.md
set -euo pipefail

# systemd-run transient units and sudo do not always set HOME. flightctl login
# still resolves the default config path via os.UserConfigDir() even when
# --config-dir is provided.
export HOME="${HOME:-/root}"

# Load enrollment parameters from JSON file (passed as $1 by the executor).
# sudo sanitizes the environment, so env vars set via cockpit.spawn's environ
# option won't reach this script. Parameters are passed via a temp file instead.
if [ -n "${1:-}" ] && [ -f "$1" ]; then
    ENROLLMENT_SERVICE_ID=$(jq -r '.ENROLLMENT_SERVICE_ID' "$1")
    ENROLLMENT_SERVICE_NAME=$(jq -r '.ENROLLMENT_SERVICE_NAME' "$1")
    ENROLLMENT_ENDPOINT=$(jq -r '.ENROLLMENT_ENDPOINT' "$1")
    ENROLLMENT_CREDENTIALS_JSON=$(jq -r '.ENROLLMENT_CREDENTIALS_JSON' "$1")
    ENROLLMENT_USE_EXISTING=$(jq -r '.ENROLLMENT_USE_EXISTING // false' "$1")
    ENROLLMENT_HOSTNAME=$(jq -r '.ENROLLMENT_HOSTNAME' "$1")
    ENROLLMENT_INTERFACE=$(jq -r '.ENROLLMENT_INTERFACE' "$1")
    ENROLLMENT_PROXY_ENABLED=$(jq -r '.ENROLLMENT_PROXY_ENABLED // false' "$1")
    ENROLLMENT_PROXY_PROTOCOL=$(jq -r '.ENROLLMENT_PROXY_PROTOCOL // "http"' "$1")
    ENROLLMENT_PROXY_HOSTNAME=$(jq -r '.ENROLLMENT_PROXY_HOSTNAME // empty' "$1")
    ENROLLMENT_PROXY_PORT=$(jq -r '.ENROLLMENT_PROXY_PORT // empty' "$1")
    ENROLLMENT_PROXY_USERNAME=$(jq -r '.ENROLLMENT_PROXY_USERNAME // empty' "$1")
    ENROLLMENT_PROXY_PASSWORD=$(jq -r '.ENROLLMENT_PROXY_PASSWORD // empty' "$1")
    ENROLLMENT_PROXY_NO_PROXY=$(jq -r '.ENROLLMENT_PROXY_NO_PROXY // empty' "$1")
    export ENROLLMENT_SERVICE_ID ENROLLMENT_SERVICE_NAME ENROLLMENT_ENDPOINT
    rm -f "$1"
fi

AGENT_CONFIG="/etc/flightctl/config.yaml"
AGENT_CERTS_DIR="/etc/flightctl/certs"
ONBOARDING_GATE_FILE="/var/lib/cockpit-system-onboarding/.onboarding-confirmed"

install_agent_certs() {
    local source_dir="$1"
    mkdir -p "$AGENT_CERTS_DIR"
    shopt -s nullglob
    local cert_file
    for cert_file in "$source_dir"/*.crt "$source_dir"/*.key "$source_dir"/ca.crt; do
        install -m 0600 "$cert_file" "${AGENT_CERTS_DIR}/$(basename "$cert_file")"
    done
    shopt -u nullglob
}

finalize_agent_config() {
    if command -v restorecon >/dev/null 2>&1; then
        restorecon -Rv /etc/flightctl >/dev/null 2>&1 || true
    fi

    # cockpit-system-onboarding installs a systemd drop-in that blocks flightctl-agent
    # until onboarding cleanup creates .onboarding-confirmed.
    if [ ! -f "$ONBOARDING_GATE_FILE" ]; then
        echo "INFO: Onboarding gate active — deferring flightctl-agent start until onboarding completes"
        systemctl enable flightctl-agent 2>/dev/null || true
        return 0
    fi

    echo "STEP: Restarting flightctl-agent"
    if ! systemctl restart flightctl-agent; then
        echo "ERROR: Failed to restart flightctl-agent"
        exit 1
    fi

    for _ in $(seq 1 15); do
        if systemctl is-active --quiet flightctl-agent; then
            echo "OK: flightctl-agent is running"
            return 0
        fi
        sleep 1
    done

    echo "ERROR: flightctl-agent is not running after restart"
    journalctl -u flightctl-agent -n 30 --no-pager >&2 || true
    exit 1
}

# Verify required tools
for cmd in jq systemctl; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: '$cmd' is not installed"
        exit 1
    fi
done

# Verify flightctl-agent is installed
if ! systemctl cat flightctl-agent.service >/dev/null 2>&1; then
    echo "ERROR: flightctl-agent service is not installed"
    exit 1
fi

# Set up proxy environment if proxy is configured
PROXY_URL=""
PROXY_NO_PROXY="${ENROLLMENT_PROXY_NO_PROXY:-localhost,127.0.0.1,::1}"
if [ "$ENROLLMENT_PROXY_ENABLED" = "true" ] && [ -n "$ENROLLMENT_PROXY_HOSTNAME" ] && [ -n "$ENROLLMENT_PROXY_PORT" ]; then
    PROXY_SCHEME="${ENROLLMENT_PROXY_PROTOCOL:-http}"
    if [ -n "$ENROLLMENT_PROXY_USERNAME" ] && [ -n "$ENROLLMENT_PROXY_PASSWORD" ]; then
        PROXY_URL="${PROXY_SCHEME}://${ENROLLMENT_PROXY_USERNAME}:${ENROLLMENT_PROXY_PASSWORD}@${ENROLLMENT_PROXY_HOSTNAME}:${ENROLLMENT_PROXY_PORT}"
    else
        PROXY_URL="${PROXY_SCHEME}://${ENROLLMENT_PROXY_HOSTNAME}:${ENROLLMENT_PROXY_PORT}"
    fi
    export HTTPS_PROXY="$PROXY_URL"
    export HTTP_PROXY="$PROXY_URL"
    export NO_PROXY="$PROXY_NO_PROXY"
    echo "INFO: Using proxy ${PROXY_SCHEME}://${ENROLLMENT_PROXY_HOSTNAME}:${ENROLLMENT_PROXY_PORT}"
fi

if [ "${ENROLLMENT_USE_EXISTING:-false}" != "true" ]; then
    # Verify flightctl CLI is available for new enrollment
    if ! command -v flightctl &>/dev/null; then
        echo "ERROR: flightctl CLI is not installed"
        exit 1
    fi

    # Parse credentials from environment (supports token or username+password)
    TOKEN=$(echo "$ENROLLMENT_CREDENTIALS_JSON" | jq -r '.token // empty')
    USERNAME=$(echo "$ENROLLMENT_CREDENTIALS_JSON" | jq -r '.username // empty')
    PASSWORD=$(echo "$ENROLLMENT_CREDENTIALS_JSON" | jq -r '.password // empty')

    # Validate that we have at least one auth method
    if [ -z "$TOKEN" ] && { [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; }; then
        echo "ERROR: Credentials must contain either 'token' or both 'username' and 'password'"
        exit 2
    fi

    # Create isolated temp directory for flightctl client config
    TMPDIR=$(mktemp -d)
    chmod 700 "$TMPDIR"
    cleanup() { rm -rf "$TMPDIR"; }
    trap cleanup EXIT

    # Step 1: Login to management service API
    echo "STEP: Logging into Flight Control"
    if [ -n "$TOKEN" ]; then
        if ! errout=$(flightctl login "$ENROLLMENT_ENDPOINT" --token "$TOKEN" --config-dir "$TMPDIR" -k 2>&1 >/dev/null); then
            echo "ERROR: flightctl login failed: ${errout#Error: }"
            exit 2
        fi
    else
        # Note: -p exposes password in /proc/PID/cmdline; unavoidable with current
        # flightctl CLI. The isolated temp config dir limits exposure window.
        if ! errout=$(flightctl login "$ENROLLMENT_ENDPOINT" -u "$USERNAME" -p "$PASSWORD" --config-dir "$TMPDIR" -k 2>&1 >/dev/null); then
            echo "ERROR: flightctl login failed: ${errout#Error: }"
            exit 2
        fi
    fi
    echo "OK: Logged into Flight Control"

    # Step 2: Request enrollment certificate
    echo "STEP: Requesting enrollment certificate"
    # stdout contains the YAML config; stderr has progress output we suppress
    if ! flightctl certificate request \
        --signer=enrollment \
        --expiration=365d \
        --output=embedded \
        --config-dir "$TMPDIR" \
        -d "$TMPDIR" > "$TMPDIR/config.yaml" 2>"$TMPDIR/cert-request.log"; then
        echo "ERROR: flightctl certificate request failed: $(cat "$TMPDIR/cert-request.log")"
        exit 1
    fi
    echo "OK: Enrollment certificate received"

    # Step 3: Install agent config and enrollment certificates
    echo "STEP: Installing agent configuration"
    if ! mkdir -p "$(dirname "$AGENT_CONFIG")"; then
        echo "ERROR: Failed to create config directory"
        exit 1
    fi
    if ! install_agent_certs "$TMPDIR"; then
        echo "ERROR: Failed to install agent certificates"
        exit 1
    fi
    if ! install -m 0600 "$TMPDIR/config.yaml" "$AGENT_CONFIG"; then
        echo "ERROR: Failed to install $AGENT_CONFIG"
        exit 1
    fi
    echo "OK: Agent configuration installed"
else
    echo "INFO: Using existing enrollment credentials — skipping login and certificate request"
fi

finalize_agent_config

if [ "${ENROLLMENT_USE_EXISTING:-false}" = "true" ]; then
    echo "OK: Flight Control agent restarted with existing credentials"
else
    echo "OK: Enrollment credentials provisioned to Flight Control agent"
fi
exit 0
