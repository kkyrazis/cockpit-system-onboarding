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
    ENROLLMENT_TLS_MODE=$(jq -r '.ENROLLMENT_TLS_MODE // "system"' "$1")
    ENROLLMENT_CA_CERT_PEM=$(jq -r '.ENROLLMENT_CA_CERT_PEM // empty' "$1")
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
        echo "Onboarding gate active — deferring flightctl-agent start until onboarding completes"
        systemctl enable flightctl-agent 2>/dev/null || true
        return 0
    fi

    echo "Restarting flightctl-agent..."
    if ! systemctl restart flightctl-agent; then
        echo "Error: failed to restart flightctl-agent" >&2
        exit 1
    fi

    for _ in $(seq 1 15); do
        if systemctl is-active --quiet flightctl-agent; then
            return 0
        fi
        sleep 1
    done

    echo "Error: flightctl-agent is not running after restart" >&2
    journalctl -u flightctl-agent -n 30 --no-pager >&2 || true
    exit 1
}

# Verify required tools
for cmd in jq systemctl; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: '$cmd' is not installed" >&2
        exit 1
    fi
done

# Verify flightctl-agent is installed
if ! systemctl list-unit-files flightctl-agent.service | grep -q flightctl-agent; then
    echo "Error: flightctl-agent service is not installed" >&2
    echo "Hint: install the flightctl-agent package before enrolling" >&2
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
    echo "Using proxy: ${PROXY_SCHEME}://${ENROLLMENT_PROXY_HOSTNAME}:${ENROLLMENT_PROXY_PORT}"
fi

if [ "${ENROLLMENT_USE_EXISTING:-false}" != "true" ]; then
    # Verify flightctl CLI is available for new enrollment
    if ! command -v flightctl &>/dev/null; then
        echo "Error: 'flightctl' is not installed" >&2
        exit 1
    fi

    # Parse credentials from environment (supports token or username+password)
    TOKEN=$(echo "$ENROLLMENT_CREDENTIALS_JSON" | jq -r '.token // empty')
    USERNAME=$(echo "$ENROLLMENT_CREDENTIALS_JSON" | jq -r '.username // empty')
    PASSWORD=$(echo "$ENROLLMENT_CREDENTIALS_JSON" | jq -r '.password // empty')

    # Validate that we have at least one auth method
    if [ -z "$TOKEN" ] && { [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; }; then
        echo "Error: credentials must contain either 'token' or both 'username' and 'password'" >&2
        exit 2
    fi

    # Create isolated temp directory for flightctl client config
    TMPDIR=$(mktemp -d)
    chmod 700 "$TMPDIR"
    cleanup() { rm -rf "$TMPDIR"; }
    trap cleanup EXIT

    TLS_ARGS=()
    if [ "${ENROLLMENT_TLS_MODE:-system}" = "insecure" ]; then
        TLS_ARGS+=("-k")
    elif [ "${ENROLLMENT_TLS_MODE:-system}" = "customCa" ] && [ -n "${ENROLLMENT_CA_CERT_PEM:-}" ]; then
        echo "$ENROLLMENT_CA_CERT_PEM" > "$TMPDIR/ca.crt"
        chmod 600 "$TMPDIR/ca.crt"
        TLS_ARGS+=("--certificate-authority" "$TMPDIR/ca.crt")
    fi

    # Step 1: Login to management service API
    echo "Logging into ${ENROLLMENT_SERVICE_NAME}..."
    if [ -n "$TOKEN" ]; then
        if ! output=$(flightctl login "$ENROLLMENT_ENDPOINT" --token "$TOKEN" --config-dir "$TMPDIR" "${TLS_ARGS[@]}" 2>&1); then
            echo "Error: flightctl login failed (token auth)" >&2
            echo "$output" >&2
            exit 2
        fi
    else
        # Note: -p exposes password in /proc/PID/cmdline; unavoidable with current
        # flightctl CLI. The isolated temp config dir limits exposure window.
        if ! output=$(flightctl login "$ENROLLMENT_ENDPOINT" -u "$USERNAME" -p "$PASSWORD" --config-dir "$TMPDIR" "${TLS_ARGS[@]}" 2>&1); then
            echo "Error: flightctl login failed (password auth)" >&2
            echo "$output" >&2
            exit 2
        fi
    fi

    # Step 2: Request enrollment certificate
    echo "Requesting enrollment certificate..."
    # stdout contains the YAML config; stderr has progress output we suppress
    if ! flightctl certificate request \
        --signer=enrollment \
        --expiration=365d \
        --output=embedded \
        --config-dir "$TMPDIR" \
        -d "$TMPDIR" > "$TMPDIR/config.yaml" 2>"$TMPDIR/cert-request.log"; then
        echo "Error: flightctl certificate request failed" >&2
        cat "$TMPDIR/cert-request.log" >&2
        exit 1
    fi

    # Step 3: Install agent config and enrollment certificates
    echo "Installing agent configuration..."
    mkdir -p "$(dirname "$AGENT_CONFIG")"
    install_agent_certs "$TMPDIR"
    install -m 0600 "$TMPDIR/config.yaml" "$AGENT_CONFIG" || {
        echo "Error: failed to install $AGENT_CONFIG" >&2
        exit 1
    }
else
    echo "Using existing enrollment credentials — skipping login and certificate request."
fi

# Write systemd proxy drop-in for flightctl-agent if proxy is configured
if [ -n "$PROXY_URL" ]; then
    PROXY_DROPIN_DIR="/etc/systemd/system/flightctl-agent.service.d"
    PROXY_DROPIN="${PROXY_DROPIN_DIR}/proxy.conf"
    echo "Writing proxy configuration to $PROXY_DROPIN..."
    mkdir -p "$PROXY_DROPIN_DIR"
    PROXY_TMPFILE=$(mktemp "${PROXY_DROPIN}.XXXXXX")
    cat > "$PROXY_TMPFILE" <<PROXY_EOF
[Service]
Environment="HTTPS_PROXY=${PROXY_URL}"
Environment="HTTP_PROXY=${PROXY_URL}"
Environment="NO_PROXY=${PROXY_NO_PROXY}"
PROXY_EOF
    chmod 0600 "$PROXY_TMPFILE"
    mv "$PROXY_TMPFILE" "$PROXY_DROPIN"
    systemctl daemon-reload
fi

finalize_agent_config

if [ "${ENROLLMENT_USE_EXISTING:-false}" = "true" ]; then
    echo "Successfully restarted ${ENROLLMENT_SERVICE_NAME} agent with existing credentials"
else
    echo "Successfully provisioned enrollment credentials to ${ENROLLMENT_SERVICE_NAME} agent"
fi
exit 0
