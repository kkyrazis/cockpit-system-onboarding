#!/bin/bash
# Shared constants and functions for flightctl-onboarding scripts
# Source this file: . /usr/libexec/flightctl-onboarding/common.sh

ONBOARDING_USER_CONFIG="/etc/cockpit/system-onboarding/config.json"
ONBOARDING_DEFAULT_CONFIG="/usr/share/cockpit/system-onboarding/config.json"
ONBOARDING_MARKER_DIR="/var/lib/flightctl-onboarding"
ONBOARDING_SCRIPTS_DIR="/usr/libexec/flightctl-onboarding"
ONBOARDING_RUNTIME_DIR="/run/flightctl-onboarding"
ONBOARDING_SETUP_CONNECTION="flightctl-onboarding-ethernet"

# Load a configuration value with fallback hierarchy:
#   1. User override (/etc/cockpit/system-onboarding/config.json)
#   2. Package default (/usr/share/cockpit/system-onboarding/config.json)
#   3. Built-in default (second argument)
# Usage: load_config '.key.path' 'default_value'
load_config() {
    local key="$1"
    local default="$2"
    local value_type

    if [ -f "$ONBOARDING_USER_CONFIG" ]; then
        value_type=$(jq -r "$key | type" "$ONBOARDING_USER_CONFIG" 2>/dev/null)
        if [ "$value_type" != "null" ]; then
            jq -r "$key" "$ONBOARDING_USER_CONFIG" 2>/dev/null
            return
        fi
    fi

    if [ -f "$ONBOARDING_DEFAULT_CONFIG" ]; then
        value_type=$(jq -r "$key | type" "$ONBOARDING_DEFAULT_CONFIG" 2>/dev/null)
        if [ "$value_type" != "null" ]; then
            jq -r "$key" "$ONBOARDING_DEFAULT_CONFIG" 2>/dev/null
            return
        fi
    fi

    echo "$default"
}

# Disarm the connectivity watchdog so it cannot fire while the caller
# writes a failure status or performs a rollback.
disarm_watchdog() {
    systemctl stop flightctl-onboarding-watchdog.timer 2>/dev/null || true
    rm -f "${ONBOARDING_MARKER_DIR}/.watchdog-active" 2>/dev/null || true
    # Stop the service last — when called from watchdog-rollback.sh this
    # sends SIGTERM to the running script, so any work must finish first.
    systemctl stop flightctl-onboarding-watchdog.service 2>/dev/null || true
}

validate_hostname_or_ip() {
    local value="$1"
    if [[ ! "$value" =~ ^[a-zA-Z0-9.:-]+$ ]]; then
        echo "ERROR: Invalid hostname or IP: $value" >&2
        exit 1
    fi
}

prefix_to_netmask() {
    local prefix=$1
    local mask=$((0xFFFFFFFF << (32 - prefix) & 0xFFFFFFFF))
    printf "%d.%d.%d.%d\n" \
        $(( (mask >> 24) & 0xFF )) \
        $(( (mask >> 16) & 0xFF )) \
        $(( (mask >> 8)  & 0xFF )) \
        $(( mask         & 0xFF ))
}

# Auto-detect the best network interface of a given type.
# Prefers disconnected interfaces over connected ones (avoids reconfiguring
# a NIC that already has upstream connectivity). Sorts by name for
# deterministic tiebreaking.
# Usage: detect_interface "ethernet"   or   detect_interface "wifi"
# Prints the chosen device name to stdout; returns 1 if none found.
detect_interface() {
    local type="$1"
    local all disconnected chosen

    all=$(nmcli -t -f DEVICE,TYPE,STATE device 2>/dev/null \
        | grep ":${type}:" \
        | cut -d: -f1 \
        | sort)

    if [ -z "$all" ]; then
        return 1
    fi

    local count
    count=$(echo "$all" | wc -l)

    if [ "$count" -eq 1 ]; then
        echo "$all"
        return 0
    fi

    disconnected=$(nmcli -t -f DEVICE,TYPE,STATE device 2>/dev/null \
        | grep ":${type}:disconnected$" \
        | cut -d: -f1 \
        | sort)

    if [ -n "$disconnected" ]; then
        chosen=$(echo "$disconnected" | head -n 1)
        local disc_count
        disc_count=$(echo "$disconnected" | wc -l)
        if [ "$disc_count" -gt 1 ]; then
            echo "WARNING: $disc_count disconnected ${type} interfaces found ($(echo "$disconnected" | tr '\n' ' '| sed 's/ $//')), selected $chosen" >&2
        else
            echo "INFO: $count ${type} interfaces found, selected disconnected interface $chosen over connected ones" >&2
        fi
    else
        chosen=$(echo "$all" | head -n 1)
        echo "WARNING: $count ${type} interfaces found, all connected — selected $chosen by name" >&2
    fi

    echo "$chosen"
    return 0
}

get_cockpit_port() {
    local port
    port=$(systemctl show cockpit.socket -p Listen 2>/dev/null | grep -oE '[0-9]+[[:space:]]+\(Stream\)' | head -1 | grep -oE '[0-9]+')
    echo "${port:-9090}"
}

restore_setup_network() {
    # Reactivate the Ethernet setup connection if it exists
    if nmcli connection show "$ONBOARDING_SETUP_CONNECTION" >/dev/null 2>&1; then
        nmcli connection up "$ONBOARDING_SETUP_CONNECTION" 2>/dev/null || true
        echo "Reactivated onboarding Ethernet connection"
    fi

    # Restart all WiFi AP instances (Wants= pulls in their dnsmasq + captive portal)
    local unit
    while IFS= read -r unit; do
        [ -n "$unit" ] || continue
        systemctl start "$unit" 2>/dev/null || true
        echo "Restarted $unit"
    done < <(systemctl list-units --plain --no-legend --all 'flightctl-onboarding-wifi-ap@*.service' 2>/dev/null | awk '{print $1}')

    # Restart all dnsmasq instances (covers Ethernet dnsmasq not pulled in by WiFi AP)
    while IFS= read -r unit; do
        [ -n "$unit" ] || continue
        systemctl start "$unit" 2>/dev/null || true
        echo "Restarted $unit"
    done < <(systemctl list-units --plain --no-legend --all 'flightctl-onboarding-dnsmasq@*.service' 2>/dev/null | awk '{print $1}')
}

ONBOARDING_HOOKS_DIR="/usr/libexec/flightctl-onboarding/hooks.d"

# Invoke the user-provided status hook with a lifecycle state argument.
# Reads statusHook.enabled and statusHook.tool from config; validates that
# the tool is a plain filename within hooks.d, root-owned, and executable.
# Always returns 0 — failures are logged but never block onboarding.
# Usage: invoke_status_hook "ready"
invoke_status_hook() {
    local state="$1"
    local hook_enabled hook_tool tool_path resolved

    hook_enabled=$(load_config '.statusHook.enabled' 'false')
    [ "$hook_enabled" = "true" ] || return 0

    hook_tool=$(load_config '.statusHook.tool' '')
    [ -n "$hook_tool" ] || return 0

    case "$hook_tool" in
        */* | *..* )
            echo "Status hook tool name contains invalid characters: $hook_tool"
            return 0
            ;;
    esac

    tool_path="${ONBOARDING_HOOKS_DIR}/${hook_tool}"

    if [ ! -f "$tool_path" ]; then
        echo "Status hook not found: $tool_path"
        return 0
    fi

    if [ ! -x "$tool_path" ]; then
        echo "Status hook not executable: $tool_path"
        return 0
    fi

    resolved=$(realpath "$tool_path")
    case "$resolved" in
        "${ONBOARDING_HOOKS_DIR}/"* ) ;;
        * )
            echo "Status hook resolves outside hooks directory: $resolved"
            return 0
            ;;
    esac

    timeout 5s "$tool_path" "$state" 2>&1 || echo "Status hook failed for state '$state' (non-fatal)"
    return 0
}

ONBOARDING_FW_ZONE="fc-onboarding-ap"

# Ensure the dedicated onboarding firewalld zone exists.
# Idempotent — safe to call from multiple setup scripts regardless of ordering.
# Returns 0 if firewalld is active (zone ready), 1 if firewalld is not active.
ensure_firewall_zone() {
    if ! command -v firewall-cmd >/dev/null 2>&1 || ! systemctl is-active --quiet firewalld; then
        echo "firewalld is not active, skipping firewall zone setup"
        return 0
    fi
    if firewall-cmd --permanent --info-zone="$ONBOARDING_FW_ZONE" >/dev/null 2>&1; then
        echo "Firewalld zone '$ONBOARDING_FW_ZONE' already exists"
        return 0
    fi
    firewall-cmd --permanent --new-zone="$ONBOARDING_FW_ZONE"
    firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --set-target=REJECT
    firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --add-service=dhcp
    firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --add-service=dns
    COCKPIT_PORT=$(get_cockpit_port)
    firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --add-port=${COCKPIT_PORT}/tcp
    firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --add-port=80/tcp
    firewall-cmd --reload
    echo "Created firewalld zone '$ONBOARDING_FW_ZONE'"
}

compute_dhcp_range() {
    local base_ip=$1
    local prefix=$2
    local range_size=$3

    IFS='.' read -r a b c d <<< "$base_ip"
    local base_num=$(( (a << 24) + (b << 16) + (c << 8) + d ))
    local start_num=$(( base_num + 1 ))
    local end_num=$(( start_num + range_size - 1 ))

    DHCP_RANGE_START=$(printf "%d.%d.%d.%d" \
        $(( (start_num >> 24) & 0xFF )) \
        $(( (start_num >> 16) & 0xFF )) \
        $(( (start_num >> 8)  & 0xFF )) \
        $(( start_num         & 0xFF )))
    DHCP_RANGE_END=$(printf "%d.%d.%d.%d" \
        $(( (end_num >> 24) & 0xFF )) \
        $(( (end_num >> 16) & 0xFF )) \
        $(( (end_num >> 8)  & 0xFF )) \
        $(( end_num         & 0xFF )))
    DHCP_NETMASK=$(prefix_to_netmask "$prefix")
}
