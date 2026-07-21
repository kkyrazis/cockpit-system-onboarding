#!/bin/bash
# apply-and-enroll.sh - Activate network profile and run enrollment in a
# systemd-run transient unit that survives cockpit-bridge exit.
#
# Used for single-NIC scenarios where activating the new NM profile severs
# the browser connection. Cockpit sets PR_SET_PDEATHSIG(SIGTERM) on direct
# children, so a regular cockpit.spawn() subprocess would die. Running under
# systemd-run isolates this script from that signal.
#
# Usage: apply-and-enroll.sh <params-json-file>
#
# Params JSON format:
# {
#   "connectionId": "flightctl-onboarding-eth0",
#   "enrollmentScripts": [
#     { "scriptPath": "/path/to/script.sh", "paramsFile": "/tmp/.enrollment-xxx.json" }
#   ],
#   "hostname": "mydevice",
#   "originalHostname": "localhost",
#   "connectivityTestHost": "flightctl.example.com"
# }
set -euo pipefail

# shellcheck source=common.sh
. /usr/libexec/flightctl-onboarding/common.sh

# systemd-run transient units do not set HOME; child scripts and tools may need it.
export HOME="${HOME:-/root}"

LOG_FILE="/var/log/flightctl-onboarding-apply.log"
touch "$LOG_FILE"
chmod 0600 "$LOG_FILE"
WATCHDOG_STATUS_FILE="/var/lib/flightctl-onboarding/.watchdog-status"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG_FILE"; }

disarm_and_write_failure_status() {
    local message="$1"
    disarm_watchdog
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    mkdir -p "$(dirname "$WATCHDOG_STATUS_FILE")"
    jq -n \
        --arg status "app_failure" \
        --arg message "$message" \
        --arg timestamp "$timestamp" \
        '{status: $status, message: $message, timestamp: $timestamp}' > "$WATCHDOG_STATUS_FILE"
    chown onboarding:onboarding "$WATCHDOG_STATUS_FILE"
    chmod 0600 "$WATCHDOG_STATUS_FILE"
}

# Allowed directories for enrollment scripts — must match sudoers entries
ALLOWED_SCRIPT_DIRS=(
    "/usr/share/cockpit/system-onboarding/system-onboarding.d"
)

validate_script_path() {
    local script_path="$1"

    if [ ! -f "$script_path" ]; then
        log "ERROR: Enrollment script does not exist: $script_path"
        return 1
    fi

    local resolved
    resolved=$(realpath "$script_path")

    local allowed=false
    for dir in "${ALLOWED_SCRIPT_DIRS[@]}"; do
        local resolved_dir
        resolved_dir=$(realpath "$dir" 2>/dev/null) || continue
        if [[ "$resolved" == "${resolved_dir}/"* ]]; then
            allowed=true
            break
        fi
    done

    if [ "$allowed" != "true" ]; then
        log "ERROR: Enrollment script is not in an allowed directory: $resolved"
        log "Allowed directories: ${ALLOWED_SCRIPT_DIRS[*]}"
        return 1
    fi

    local owner
    owner=$(stat -c '%u' "$resolved")
    if [ "$owner" != "0" ]; then
        log "ERROR: Enrollment script is not owned by root: $resolved (owner uid=$owner)"
        return 1
    fi

    return 0
}

PARAMS_FILE="$1"
CONNECTION_ID=$(jq -r '.connectionId' "$PARAMS_FILE")
INTERFACE_NAME=$(jq -r '.interfaceName // empty' "$PARAMS_FILE")
EFFECTIVE_IFACE=$(jq -r '.effectiveIfaceName // .interfaceName // empty' "$PARAMS_FILE")
HOSTNAME=$(jq -r '.hostname // empty' "$PARAMS_FILE")
ORIGINAL_HOSTNAME=$(jq -r '.originalHostname // empty' "$PARAMS_FILE")
CONNECTIVITY_TEST_HOST=$(jq -r '.connectivityTestHost // empty' "$PARAMS_FILE")
CONNECTIVITY_REQUIRED=$(jq -r 'if .connectivityTestRequired == false then "false" else "true" end' "$PARAMS_FILE")

validate_iface_name() {
    local name="$1"
    if [ -n "$name" ] && [[ ! "$name" =~ ^[a-zA-Z0-9._-]+$ ]]; then
        log "ERROR: Invalid interface name: $name"
        exit 1
    fi
}
validate_iface_name "$INTERFACE_NAME"
validate_iface_name "$EFFECTIVE_IFACE"

ROLLBACK_SCRIPT="/usr/libexec/flightctl-onboarding/rollback-config.sh"

rollback() {
    log "Rolling back applied configuration..."
    disarm_watchdog
    local rollback_params
    rollback_params=$(mktemp /tmp/.rollback-params-XXXXXX)
    chmod 600 "$rollback_params"

    local manifest
    manifest=$(jq -n \
        --arg connId "$CONNECTION_ID" \
        '{network: {connectionId: $connId}, ntp: true, proxy: true, labels: true}')
    if [ -n "$ORIGINAL_HOSTNAME" ]; then
        manifest=$(echo "$manifest" | jq --arg h "$ORIGINAL_HOSTNAME" '.hostname = {original: $h}')
    fi
    echo "$manifest" > "$rollback_params"

    "$ROLLBACK_SCRIPT" "$rollback_params" 2>&1 | while IFS= read -r line; do
        log "$line"
    done || true

    rm -f "$PARAMS_FILE" 2>/dev/null || true
    log "Rollback complete"
}
trap 'rc=$?; if [ $rc -ne 0 ]; then rollback; fi; exit $rc' EXIT

# Step 0: Stop onboarding network services on the target interface so NM
# can reclaim the device cleanly.
WIFI_AP_UNIT="flightctl-onboarding-wifi-ap@${INTERFACE_NAME}.service"
DNSMASQ_UNIT="flightctl-onboarding-dnsmasq@${INTERFACE_NAME}.service"
if [ -n "$INTERFACE_NAME" ] && systemctl is-active --quiet "$DNSMASQ_UNIT" 2>/dev/null; then
    log "Stopping onboarding DHCP on $INTERFACE_NAME"
    systemctl stop "$DNSMASQ_UNIT"
fi
if [ -n "$INTERFACE_NAME" ] && systemctl is-active --quiet "$WIFI_AP_UNIT" 2>/dev/null; then
    log "Stopping WiFi AP on $INTERFACE_NAME before activating connection"
    systemctl stop "$WIFI_AP_UNIT"
    log "WiFi AP stopped on $INTERFACE_NAME"

    # After stopping the AP, NM transitions the device through
    # unmanaged → unavailable → disconnected.  The wpa_supplicant
    # interface must come up before NM considers the device ready.
    # Wait for the device to leave "unavailable" before activating.
    log "Waiting for $INTERFACE_NAME to become ready..."
    dev_wait=0
    while [ "$dev_wait" -lt 30 ]; do
        dev_state=$(nmcli -t -f DEVICE,STATE device status 2>/dev/null | grep "^${INTERFACE_NAME}:" | cut -d: -f2) || true
        if [ -n "$dev_state" ] && [ "$dev_state" != "unavailable" ] && [ "$dev_state" != "unmanaged" ]; then
            log "Device $INTERFACE_NAME is ready (state: $dev_state)"
            break
        fi
        sleep 1
        dev_wait=$((dev_wait + 1))
    done
fi

# Step 1: Activate the new NM profile
log "Activating connection: $CONNECTION_ID"
nmcli connection up "$CONNECTION_ID"

# Step 2: Wait for link carrier, then connectivity
# In ethernet single-NIC scenarios the operator must physically move the cable
# from the configuration laptop to the production switch. Wait up to 5 minutes
# for carrier, then 30 retries at 2s intervals (~60 seconds) for connectivity.
# Carrier is checked on the physical interface, not the VLAN subinterface.
CARRIER_FILE="/sys/class/net/${INTERFACE_NAME}/carrier"
CARRIER_TIMEOUT=$(jq -r '.carrierTimeoutSeconds // 300' "$PARAMS_FILE")
CONNECTIVITY_TIMEOUT=$(jq -r '.connectivityRetries // 30' "$PARAMS_FILE")

if [ -n "$INTERFACE_NAME" ] && [ -f "$CARRIER_FILE" ]; then
    log "Waiting for link carrier on $INTERFACE_NAME (up to ${CARRIER_TIMEOUT}s)..."
    elapsed=0
    while [ "$elapsed" -lt "$CARRIER_TIMEOUT" ]; do
        if [ "$(cat "$CARRIER_FILE" 2>/dev/null)" = "1" ]; then
            log "Link carrier detected on $INTERFACE_NAME after ${elapsed}s"
            break
        fi
        if [ "$elapsed" -eq "$CARRIER_TIMEOUT" ]; then
            break
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    if [ "$(cat "$CARRIER_FILE" 2>/dev/null)" != "1" ]; then
        log "ERROR: No link carrier on $INTERFACE_NAME after ${CARRIER_TIMEOUT}s"
        exit 1
    fi
else
    log "No carrier file for $INTERFACE_NAME, skipping carrier wait"
fi

is_ip_address() {
    [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || [[ "$1" =~ ^[0-9a-fA-F:]+$ ]]
}

log "Waiting for network connectivity (up to ${CONNECTIVITY_TIMEOUT} retries)..."
for i in $(seq 1 $CONNECTIVITY_TIMEOUT); do
    if is_ip_address "$CONNECTIVITY_TEST_HOST"; then
        if ping -c1 -W2 "$CONNECTIVITY_TEST_HOST" >/dev/null 2>&1; then
            log "Network connectivity confirmed (ping)"
            break
        fi
    elif resolvectl query --interface="$EFFECTIVE_IFACE" "$CONNECTIVITY_TEST_HOST" >/dev/null 2>&1; then
        log "Network connectivity confirmed (DNS)"
        break
    fi
    if [ "$i" -eq "$CONNECTIVITY_TIMEOUT" ]; then
        if [ "$CONNECTIVITY_REQUIRED" = "true" ]; then
            log "ERROR: Network connectivity not available after $CONNECTIVITY_TIMEOUT attempts"
            exit 1
        else
            log "WARNING: Network connectivity not available after $CONNECTIVITY_TIMEOUT attempts (not required, continuing)"
            break
        fi
    fi
    sleep 2
done

# Step 3: Run enrollment scripts
SCRIPT_COUNT=$(jq '.enrollmentScripts | length' "$PARAMS_FILE")
if [ "$SCRIPT_COUNT" -gt 0 ]; then
    while IFS= read -r script_entry; do
        SCRIPT_PATH=$(echo "$script_entry" | jq -r '.scriptPath')
        SCRIPT_PARAMS=$(echo "$script_entry" | jq -r '.paramsFile')
        if ! validate_script_path "$SCRIPT_PATH"; then
            rm -f "$SCRIPT_PARAMS"
            exit 1
        fi
        log "Running enrollment script: $SCRIPT_PATH"
        enroll_output=""
        if ! enroll_output=$("$SCRIPT_PATH" "$SCRIPT_PARAMS" 2>&1); then
            log "ERROR: Enrollment script failed: $SCRIPT_PATH"
            log "$enroll_output"
            disarm_and_write_failure_status "$enroll_output"
            rm -f "$SCRIPT_PARAMS"
            exit 1
        fi
        rm -f "$SCRIPT_PARAMS"
        log "Enrollment script completed: $SCRIPT_PATH"
    done < <(jq -c '.enrollmentScripts[]' "$PARAMS_FILE")
else
    log "No enrollment scripts to run"
fi

# Step 4: Write the onboarding completion marker
FINALIZE_SCRIPT="/usr/libexec/flightctl-onboarding/finalize-onboarding.sh"
if [ -x "$FINALIZE_SCRIPT" ]; then
    log "Running finalize..."
    "$FINALIZE_SCRIPT" "$HOSTNAME"
    log "Finalize completed"
else
    log "WARNING: Finalize script not found at $FINALIZE_SCRIPT"
fi

# Step 5: Run cleanup (removes onboarding user, stops WiFi AP, starts agent)
CLEANUP_SCRIPT="/usr/libexec/flightctl-onboarding/cleanup-onboarding.sh"
if [ -x "$CLEANUP_SCRIPT" ]; then
    log "Running cleanup..."
    "$CLEANUP_SCRIPT"
    log "Cleanup completed"
else
    log "WARNING: Cleanup script not found at $CLEANUP_SCRIPT"
fi

log "Onboarding completed successfully"

# Clean up params file
rm -f "$PARAMS_FILE"
