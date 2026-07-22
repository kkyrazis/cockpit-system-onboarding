#!/bin/bash
# Configure WiFi Access Point for initial system access
# Part of flightctl-onboarding first-boot setup

set -e

# shellcheck source=common.sh
. /usr/libexec/flightctl-onboarding/common.sh

RUNTIME_DIR="$ONBOARDING_RUNTIME_DIR"

# Check if either config file exists
if [ ! -f "$ONBOARDING_USER_CONFIG" ] && [ ! -f "$ONBOARDING_DEFAULT_CONFIG" ]; then
    echo "No configuration file found"
    echo "Skipping WiFi AP setup"
    exit 0
fi

# Check if WiFi AP is enabled
WIFI_AP_ENABLED=$(load_config '.network.wifiAp.enabled' 'false')
if [ "$WIFI_AP_ENABLED" != "true" ]; then
    echo "WiFi AP is disabled in configuration"
    exit 0
fi

# Check for hostapd
if ! command -v hostapd >/dev/null 2>&1; then
    echo "WARNING: hostapd is not installed, cannot create WiFi AP"
    echo "Install with: dnf install hostapd"
    exit 0
fi

# Get configuration values
SSID_PREFIX=$(load_config '.network.wifiAp.ssidPrefix' 'flightctl-')
PASSWORD=$(load_config '.network.wifiAp.password' '')
AP_ADDRESS=$(load_config '.network.wifiAp.address' '10.42.0.1')
AP_SUBNET_PREFIX=$(load_config '.network.wifiAp.subnetPrefix' '24')
AP_DHCP_RANGE_SIZE=$(load_config '.network.wifiAp.dhcpRangeSize' '40')
AP_CHANNEL=$(load_config '.network.wifiAp.channel' '6')

compute_dhcp_range "$AP_ADDRESS" "$AP_SUBNET_PREFIX" "$AP_DHCP_RANGE_SIZE"

WIFI_AP_IFACE=$(load_config '.network.wifiAp.interface' '')
if [ -n "$WIFI_AP_IFACE" ]; then
    if ! nmcli -t -f DEVICE,TYPE device | grep -q "^${WIFI_AP_IFACE}:wifi$"; then
        echo "ERROR: Configured WiFi AP interface '$WIFI_AP_IFACE' is not a WiFi device or does not exist"
        exit 1
    fi
    WIFI_INTERFACE="$WIFI_AP_IFACE"
    echo "Using configured WiFi interface: $WIFI_INTERFACE"
else
    if ! WIFI_INTERFACE=$(detect_interface wifi); then
        WIFI_INTERFACE=""
    fi
fi

if [ -z "$WIFI_INTERFACE" ]; then
    echo "No WiFi interface found"
    echo "Skipping WiFi AP setup"
    exit 0
fi

echo "Using WiFi interface: $WIFI_INTERFACE"

# Generate SSID suffix from DMI product serial, falling back to MAC address
DMI_SERIAL_FILE="/sys/class/dmi/id/product_serial"
SSID_SUFFIX=""
if [ -f "$DMI_SERIAL_FILE" ]; then
    DMI_SERIAL=$(tr -d '[:space:]' < "$DMI_SERIAL_FILE")
    case "$DMI_SERIAL" in
        ''|'DefaultString'|'Default string'|'ToBeFilledByO.E.M.'|'ToBeFilled')
            DMI_SERIAL=""
            ;;
    esac
    if [ -n "$DMI_SERIAL" ]; then
        SSID_SUFFIX=$(printf '%s' "$DMI_SERIAL" | tail -c 8)
    fi
fi

if [ -z "$SSID_SUFFIX" ]; then
    # Read the permanent hardware MAC via udev to avoid NM's MAC randomization.
    # ID_NET_NAME_MAC embeds the burned-in MAC as "wlx<12 hex digits>".
    MAC_RAW=$(udevadm info -q property "/sys/class/net/${WIFI_INTERFACE}" 2>/dev/null | sed -n 's/^ID_NET_NAME_MAC=wlx//p')
    if [ -z "$MAC_RAW" ]; then
        MAC_RAW=$(tr -d ':' < "/sys/class/net/${WIFI_INTERFACE}/address")
    fi
    SSID_SUFFIX=$(printf '%s' "$MAC_RAW" | tail -c 6)
fi

SSID="${SSID_PREFIX}${SSID_SUFFIX}"
echo "WiFi AP SSID: $SSID"

# Remove stale AP address from any other interface. A previous AP service
# may have failed without cleaning up, leaving the address on a different
# interface and causing a routing conflict.
for iface in $(ip -o addr show to "${AP_ADDRESS}/${AP_SUBNET_PREFIX}" | awk '{print $2}'); do
    if [ "$iface" != "$WIFI_INTERFACE" ]; then
        echo "Removing stale AP address from $iface"
        ip addr del "${AP_ADDRESS}/${AP_SUBNET_PREFIX}" dev "$iface" 2>/dev/null || true
    fi
done

# Create runtime directory
mkdir -p "$RUNTIME_DIR"

# Generate hostapd configuration
HOSTAPD_CONF="$RUNTIME_DIR/hostapd-${WIFI_INTERFACE}.conf"
cat > "$HOSTAPD_CONF" <<EOF
interface=${WIFI_INTERFACE}
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=${AP_CHANNEL}
wmm_enabled=0
macaddr_acl=0
ieee80211n=1
EOF

# Add WPA2 security if password is set, otherwise open network
if [ -n "$PASSWORD" ]; then
    cat >> "$HOSTAPD_CONF" <<EOF
auth_algs=1
wpa=2
wpa_passphrase=${PASSWORD}
wpa_key_mgmt=WPA-PSK
wpa_pairwise=TKIP
rsn_pairwise=CCMP
EOF
    chmod 0600 "$HOSTAPD_CONF"
    echo "WiFi AP configured with WPA2 security"
else
    cat >> "$HOSTAPD_CONF" <<EOF
auth_algs=1
EOF
    echo "WiFi AP configured as open network (no password)"
fi

# Generate dnsmasq configuration for DHCP on the AP network
DNSMASQ_CONF="$RUNTIME_DIR/dnsmasq-${WIFI_INTERFACE}.conf"
cat > "$DNSMASQ_CONF" <<EOF
interface=${WIFI_INTERFACE}
bind-interfaces
except-interface=lo
dhcp-range=${DHCP_RANGE_START},${DHCP_RANGE_END},${DHCP_NETMASK},1h
dhcp-option=3,${AP_ADDRESS}
dhcp-option=6,${AP_ADDRESS}
no-resolv
no-hosts
address=/#/${AP_ADDRESS}
dhcp-leasefile=/tmp/dnsmasq-${WIFI_INTERFACE}.leases
pid-file=/tmp/dnsmasq-${WIFI_INTERFACE}.pid
EOF
echo "Generated dnsmasq DHCP config"

# Generate environment file for the systemd service
cat > "$RUNTIME_DIR/wifi-ap.env" <<EOF
WIFI_AP_ADDRESS=${AP_ADDRESS}
WIFI_AP_NETMASK=${AP_SUBNET_PREFIX}
WIFI_AP_INTERFACE=${WIFI_INTERFACE}
EOF

# Create a dedicated firewalld zone for the AP interface if firewalld is active.
# The zone only permits DHCP, DNS, Cockpit (9090/tcp), and captive portal (80/tcp).
# All other inbound traffic on the AP interface is rejected.
ONBOARDING_FW_ZONE="fc-onboarding-ap"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    if ! firewall-cmd --permanent --info-zone="$ONBOARDING_FW_ZONE" >/dev/null 2>&1; then
        firewall-cmd --permanent --new-zone="$ONBOARDING_FW_ZONE"
        firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --set-target=REJECT
        firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --add-service=dhcp
        firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --add-service=dns
        firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --add-port=9090/tcp
        firewall-cmd --permanent --zone="$ONBOARDING_FW_ZONE" --add-port=80/tcp
        firewall-cmd --reload
        echo "Created firewalld zone '$ONBOARDING_FW_ZONE' (DHCP, DNS, Cockpit, captive portal only)"
    else
        echo "Firewalld zone '$ONBOARDING_FW_ZONE' already exists"
    fi
else
    echo "firewalld is not active, skipping firewall zone setup"
fi

# Disable IPv6 on the AP interface to prevent stray link-local addresses.
# The Ethernet path uses NM's ipv6.method=disabled; here we use sysctl
# because the interface is not managed by NetworkManager.
sysctl -w "net.ipv6.conf.${WIFI_INTERFACE}.disable_ipv6=1"

# Enable and start the WiFi AP service for this interface
systemctl enable "flightctl-onboarding-wifi-ap@${WIFI_INTERFACE}.service" 2>/dev/null || true
systemctl start "flightctl-onboarding-wifi-ap@${WIFI_INTERFACE}.service"

echo "WiFi AP started on $WIFI_INTERFACE"
echo "AP accessible at: http://${AP_ADDRESS}:9090"
