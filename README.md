# Flightctl Onboarding

[![License](https://img.shields.io/badge/License-LGPL%202.1-blue.svg)](https://opensource.org/licenses/LGPL-2.1)

A [Cockpit](https://cockpit-project.org/) module that provides a guided setup wizard for headless Linux devices.

## Overview

Headless devices — servers, edge nodes, embedded systems — often lack displays, keyboards, and pre-configured network access. Before they can onboard into management services like [Flight Control](https://flightctl.io/), they need network connectivity and credentials. The Flightctl Onboarding plugin bridges that gap.

Flightctl Onboarding runs inside [Cockpit](https://cockpit-project.org/) on the device. You connect to it from a web browser on a remote machine and are presented with a step-by-step wizard that walks you through initial device setup. By default, the service disables itself once onboarding completes and is then inert.

### Features

- **Hostname configuration** — set the system hostname
- **Device labels** — assign key/value labels for Flight Control fleet management
- **Network interface selection** — choose ethernet or WiFi, with VLAN support
- **Network addressing** — configure IPv4/IPv6 addresses, DNS, with inline validation and duplicate IP detection
- **Network services** — set NTP servers and HTTP proxy (with credential support)
- **Enrollment** — enroll into [Flight Control](https://github.com/flightctl/flightctl) with token or username/password authentication
- **WiFi AP provisioning** — optionally expose a temporary WiFi access point with captive portal for initial connectivity
- **Self-disabling** — once onboarding completes, the wizard and its services become inert

## Installing

### Building the RPM

```sh
make rpm
```

When building the RPM, you can specify the brand name shown in the enrollment UI:

```sh
BRAND_NAME="My Brand" NODE_ENV=production make rpm
```

The default brand name is `Flight Control`. The value is baked into the shipped `config.json` as `brandName` and used for enrollment service labels. Runtime overrides via `/etc/cockpit/system-onboarding/config.json` can still change the brand name if needed.

This produces `flightctl-onboarding-*.noarch.rpm` in the repository root. Install it on the target device:

```sh
sudo dnf install -y ./flightctl-onboarding-*.rpm
sudo systemctl enable --now flightctl-onboarding-setup.service
```

If provisioning over WiFi, install the additional dependencies:

```sh
sudo dnf install -y hostapd dnsmasq
```

### From source

See [DEVELOPERS.md](DEVELOPERS.md) for build instructions and development setup.

## Connecting to the Device

There are three ways to reach the onboarding wizard, depending on your setup.

### WiFi access point

If `hostapd` and `dnsmasq` are installed and WiFi is enabled in the config, the device creates a temporary WiFi access point on first boot.

- **SSID**: `flightctl-<suffix>` where `<suffix>` is the last 8 characters of the device's DMI serial number (or last 6 hex digits of the WiFi MAC address if serial is unavailable)
- **Password**: configured via `network.wifiAp.password` in `config.json` (default: `onboarding`). Set to empty string for an open network.
- **Captive portal**: after connecting, most devices will automatically open a sign-in page that redirects to the wizard. If the captive portal prompt does not appear, open `http://10.42.0.1:9090` manually.

Log in as user `onboarding` (no password by default, or the password set in `onboardingUser.password`).

### Ethernet (static IP)

If Ethernet is enabled in the config, the device creates a temporary NetworkManager connection with a static IP on the first available Ethernet interface.

1. Connect your laptop directly to the device's Ethernet port (or through a switch on the same L2 segment)
2. Configure your laptop with a static IP on the same subnet — e.g. `192.168.100.2/24` if using the default
3. Open `http://192.168.100.1:9090` in your browser (the device's default static IP)
4. Log in as user `onboarding`

If `dnsmasq` is installed, the device also runs a DHCP server on the setup interface, so you can skip step 2 and use DHCP instead.

The static IP, subnet prefix, and DHCP range are all configurable — see [Configuration](#configuration) below.

### Local console

If you have a keyboard and monitor connected to the device, open `http://localhost:9090` in a browser and log in as `onboarding`.

## HTTPS and Certificates

Cockpit serves the onboarding wizard over both HTTP and HTTPS. On first start, Cockpit auto-generates a self-signed TLS certificate stored at `/etc/cockpit/ws-certs.d/0-self-signed.cert`. HTTPS access works immediately at `https://<ip>:9090`, but browsers will show a certificate warning that must be accepted manually.

### Provisioning a custom certificate

To avoid self-signed certificate warnings, place a trusted certificate in `/etc/cockpit/ws-certs.d/`. Cockpit sorts `.cert` and `.crt` files alphabetically and uses the **last** one, so use a numeric prefix higher than `0` (e.g., `50-mycert.cert`).

Two layouts are supported:

- **Combined file** — put the certificate chain and private key in a single `.cert` file:

  ```
  /etc/cockpit/ws-certs.d/50-mycert.cert   # cert chain + unencrypted private key
  ```

- **Separate files** — use matching base names with `.cert` and `.key` extensions:

  ```
  /etc/cockpit/ws-certs.d/50-mycert.cert   # certificate chain (PEM)
  /etc/cockpit/ws-certs.d/50-mycert.key    # unencrypted private key (PEM)
  ```

The key must not be encrypted. After placing the files, restart Cockpit:

```sh
sudo systemctl restart cockpit
```

To verify which certificate is active:

```sh
sudo /usr/libexec/cockpit-certificate-ensure --check
```

See the upstream [Cockpit TLS documentation](https://cockpit-project.org/guide/latest/https) for additional options including certmonger and FreeIPA integration.

### HTTP access and known limitations

During onboarding, `AllowUnencrypted = true` is set in `/etc/cockpit/cockpit.conf` so that the captive portal and HTTP access work without TLS. The captive portal flow over HTTP works correctly on mobile devices (iOS, Android) and is the recommended path for initial setup.

> [!NOTE]
> Some browsers (observed with Chrome and Edge on Windows) may experience a login loop when navigating directly to `http://<ip>:9090` — the login appears to succeed but immediately returns to the login page. The root cause is not fully understood but is likely related to how the browser handles Cockpit's `SameSite=Strict` session cookie over plain HTTP. If this occurs, use `https://<ip>:9090` instead and accept the self-signed certificate warning.

After onboarding completes, the cleanup script removes `AllowUnencrypted` and only HTTPS is available.

## How It Works

On first boot the setup service creates a temporary `onboarding` user, optionally starts a WiFi access point, and enables the Cockpit web console. The operator connects to Cockpit, steps through the wizard pages (network, network services, enrollment, device labels, review), and clicks "Apply".

The wizard supports two operational flows depending on network topology — see [AGENTS.md](AGENTS.md) for a detailed description of each:

- **Inline (multi-NIC)**: the operator connects via one interface and configures a different one. All apply steps run in the browser session. On success, the operator clicks "Finish" to trigger cleanup.
- **Single-NIC (background delegation)**: the operator connects and configures the same interface. The wizard delegates network activation, enrollment, and cleanup to a `systemd-run` transient unit that survives the browser disconnect.

Once complete, the cleanup script removes the temporary user, tears down the WiFi AP, and marks onboarding as finished — the service will not run again.

Enrollment is handled by a drop-in shell script in `/usr/share/cockpit/system-onboarding/system-onboarding.d/`.

## Configuration

The plugin reads configuration from JSON files at two paths:

| Priority | Path | Purpose |
|----------|------|---------|
| 1 (highest) | `/etc/cockpit/system-onboarding/config.json` | Operator override — survives package upgrades |
| 2 | `/usr/share/cockpit/system-onboarding/config.json` | Package default — shipped with the RPM |

The override file does not need to contain all keys — only the values you want to change. Unset keys fall back to the package default.

### Configuration reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `version` | string | `"1.0"` | Config schema version |
| `brandName` | string | `"Flight Control"` | Brand name shown in the enrollment UI and used for service labels |
| `runOnce` | bool | `true` | Disable the onboarding service after completion |
| `keepCockpit` | bool | `false` | Keep Cockpit running post-onboarding (expires the onboarding user's password instead of deleting the user) |
| `hideModules` | bool | `true` | Hide other Cockpit modules during onboarding |
| `autoReboot` | bool | `false` | Reboot the device after onboarding completes |
| `network.activationTimeoutSeconds` | int | `30` | Seconds to wait for a NetworkManager connection to activate |
| `network.wifiAp.enabled` | bool | `true` | Enable WiFi AP provisioning |
| `network.wifiAp.ssidPrefix` | string | `"flightctl-"` | SSID prefix; suffix is auto-generated from DMI serial or MAC |
| `network.wifiAp.interface` | string | `""` | WiFi interface for the AP; empty = auto-detect |
| `network.wifiAp.password` | string | `"onboarding"` | WPA2 password; empty = open network |
| `network.wifiAp.address` | string | `"10.42.0.1"` | AP IP address |
| `network.wifiAp.subnetPrefix` | int | `24` | AP subnet prefix length |
| `network.wifiAp.dhcpRangeSize` | int | `40` | Number of DHCP leases to offer |
| `network.wifiAp.channel` | int | `6` | WiFi channel |
| `network.wifiAp.dhcpLeaseDuration` | string | `"1h"` | DHCP lease duration for WiFi AP clients (e.g. `1h`, `30m`, `3600s`) |
| `network.wifiAp.watchdogTimeoutSeconds` | int | `420` | Seconds before the network watchdog rolls back WiFi config if connectivity fails |
| `network.wifiAp.driver` | string | `"nl80211"` | Hostapd driver for the WiFi interface |
| `network.wifiAp.hwMode` | string | `"g"` | 802.11 hardware mode: `g` (2.4 GHz), `a` (5 GHz), `b` (legacy), `ad` (60 GHz) |
| `network.wifiAp.scanWaitMs` | int | `3000` | Milliseconds to wait after triggering a WiFi scan before reading results |
| `network.ethernet.enabled` | bool | `true` | Enable Ethernet setup interface |
| `network.ethernet.interface` | string | `""` | Ethernet interface for onboarding; empty = auto-detect |
| `network.ethernet.staticIp` | string | `"192.168.100.1"` | Static IP for the onboarding Ethernet interface |
| `network.ethernet.subnetPrefix` | int | `24` | Ethernet subnet prefix length |
| `network.ethernet.dhcpRangeSize` | int | `40` | Number of DHCP leases (requires dnsmasq) |
| `network.ethernet.dhcpLeaseDuration` | string | `"1h"` | DHCP lease duration for Ethernet onboarding clients |
| `network.ethernet.watchdogTimeoutSeconds` | int | `600` | Seconds before the network watchdog rolls back Ethernet config if connectivity fails |
| `flightctl.defaultEndpoint` | string | `""` | Pre-populated Flight Control server URL in the enrollment form |
| `flightctl.certificateExpiration` | string | `"365d"` | Enrollment certificate expiration duration (e.g. `365d`, `24h`) |
| `connectivityTest.host` | string | `"cockpit-project.org"` | Host used for DNS/ping connectivity checks after network apply |
| `connectivityTest.required` | bool | `true` | Block enrollment until connectivity check passes |
| `connectivityTest.connectivityTimeoutSeconds` | int | `300` | Total time budget in seconds for the connectivity loop (carrier detection, DHCP/SLAAC, and reachability check) |
| `connectivityTest.ntpSyncTimeoutSeconds` | int | `30` | Seconds to wait for NTP clock synchronization before proceeding |
| `connectivityTest.pingTimeoutSeconds` | int | `10` | Overall timeout in seconds for each ping connectivity check |
| `connectivityTest.pingWaitSeconds` | int | `5` | Seconds to wait for a single ping reply |
| `defaults.hostname` | string | `""` | Pre-populated hostname in the wizard |
| `defaults.proxy.enabled` | bool | `false` | Enable proxy by default in the wizard |
| `defaults.proxy.protocol` | string | `"http"` | Default proxy protocol (`http`, `https`, or `socks5`) |
| `defaults.proxy.applyForHttps` | bool | `false` | Also use the proxy for HTTPS traffic |
| `defaults.proxy.hostname` | string | `""` | Default proxy hostname |
| `defaults.proxy.port` | int | — | Default proxy port |
| `defaults.proxy.username` | string | `""` | Default proxy username |
| `defaults.proxy.password` | string | `""` | Default proxy password |
| `defaults.proxy.noProxy` | string | `""` | Comma-separated list of hosts to bypass the proxy |
| `defaults.ntp.autoConfig` | bool | — | Pre-select automatic NTP configuration mode |
| `defaults.ntp.servers` | array | `[]` | Default NTP server list to pre-populate when system has no configured servers |
| `defaults.networkAddress.ipv4.method` | string | — | Pre-select IPv4 method: `auto`, `static`, or `disabled` |
| `defaults.networkAddress.ipv4.address` | string | — | Default static IPv4 address |
| `defaults.networkAddress.ipv4.subnetMask` | string | — | Default subnet mask |
| `defaults.networkAddress.ipv4.gateway` | string | — | Default gateway |
| `defaults.networkAddress.ipv4.primaryDns` | string | — | Default primary DNS server |
| `defaults.networkAddress.ipv4.secondaryDns` | string | — | Default secondary DNS server |
| `defaults.networkAddress.ipv6.method` | string | — | Pre-select IPv6 method: `auto`, `dhcp`, `static`, or `disabled` |
| `defaults.networkAddress.ipv6.address` | string | — | Default static IPv6 address (with /prefix) |
| `defaults.networkAddress.ipv6.gateway` | string | — | Default IPv6 gateway |
| `defaults.networkAddress.ipv6.primaryDns` | string | — | Default primary IPv6 DNS server |
| `defaults.networkAddress.ipv6.secondaryDns` | string | — | Default secondary IPv6 DNS server |
| `defaults.labels.deviceLabels` | array | `[]` | Pre-populated device labels (`[{key, value}]`) |
| `defaults.labels.systemInfoMappings` | array | `[]` | Pre-populated system-info label mappings (`[{key, value}]`) |
| `defaults.alias.mode` | string | — | Default alias mode for the device |
| `defaults.alias.customValue` | string | `""` | Custom alias value when mode is custom |
| `onboardingUser.password` | string | `""` | Password for the `onboarding` Cockpit user; empty = passwordless login |
| `statusHook.enabled` | bool | `false` | Enable status hook invocation during onboarding lifecycle transitions |
| `statusHook.tool` | string | — | Filename of the hook executable in `/usr/libexec/flightctl-onboarding/hooks.d/`; required when `statusHook.enabled` is `true` |

### Example override

To change the setup Ethernet IP, pre-populate the Flight Control endpoint, and configure NTP defaults, create `/etc/cockpit/system-onboarding/config.json`:

```json
{
  "network": {
    "ethernet": {
      "staticIp": "10.0.0.1",
      "watchdogTimeoutSeconds": 900
    },
    "wifiAp": {
      "hwMode": "a",
      "dhcpLeaseDuration": "30m"
    }
  },
  "flightctl": {
    "defaultEndpoint": "https://api.flightctl.example.com:7443",
    "certificateExpiration": "180d"
  },
  "connectivityTest": {
    "ntpSyncTimeoutSeconds": 60
  },
  "defaults": {
    "ntp": {
      "servers": ["ntp1.example.com", "ntp2.example.com"]
    }
  }
}
```

## Status Hook

The status hook feature lets you run a custom executable at key onboarding lifecycle transitions. Your script receives a single argument — the state name — and can do anything: control LEDs, send notifications, update a display, etc.

### Configuration

```json
{
  "statusHook": {
    "enabled": true,
    "tool": "my-status-handler"
  }
}
```

### Hook placement

Place your executable in `/usr/libexec/flightctl-onboarding/hooks.d/`. The directory is root-owned; only root can add or modify files there. The `statusHook.tool` value is a filename only — no paths or `..` are allowed.

### Lifecycle states

| State | When it fires |
|-------|---------------|
| `ready` | Boot — setup service starts |
| `in-progress` | Wizard loads in the browser |
| `applying` | User clicks Apply |
| `success` | Configuration applied successfully |
| `error` | Configuration failed |
| `off` | Onboarding finished (before cleanup/reboot) |

In single-NIC mode, `success`, `error`, and `off` are fired by the background apply script (since the browser connection is severed).

### Failure handling

Hook failures are always non-blocking — they are logged but never prevent onboarding from completing. The hook is invoked with a 5-second timeout.

### Example: LED control

A hook script for controlling a GPIO-connected LED on a Raspberry Pi:

```bash
#!/bin/bash
LED_GPIO=17
GPIO_PATH="/sys/class/gpio/gpio${LED_GPIO}"

[ -d "$GPIO_PATH" ] || echo "$LED_GPIO" > /sys/class/gpio/export
echo "out" > "$GPIO_PATH/direction"

case "$1" in
    ready)       echo 1 > "$GPIO_PATH/value" ;;
    in-progress) echo 1 > "$GPIO_PATH/value" ;;
    applying)    echo 1 > "$GPIO_PATH/value" ;;
    success)     echo 1 > "$GPIO_PATH/value" ;;
    error)       echo 0 > "$GPIO_PATH/value" ;;
    off)         echo 0 > "$GPIO_PATH/value" ;;
esac
```

## Security Model

During onboarding, the device runs with a deliberately reduced security posture to enable first-boot setup from the local network. The setup service creates a temporary `onboarding` user that is passwordless by default (configurable via `onboardingUser.password`) and enables `AllowUnencrypted = true` in Cockpit so the captive portal and HTTP access work without TLS. These trade-offs are scoped to the onboarding window and cleaned up automatically on completion.

**Access controls during onboarding:**

- **SSH is blocked** — `DenyUsers onboarding` is added to sshd config, preventing remote shell access to the onboarding account. Only Cockpit web console access is allowed.
- **Polkit rules** restrict the onboarding user to specific D-Bus actions (hostname, timedate, NetworkManager). No wildcards are used.
- **Sudoers rules** allow passwordless sudo for specific onboarding scripts only. Each script performs its own argument validation.
- **Credentials** (enrollment tokens, proxy passwords) are written to temp files with `0600` permissions, passed as file paths (not CLI arguments), and deleted immediately after use.

**After onboarding completes:**

- The `onboarding` user is deleted (unless `keepCockpit: true` is set, in which case the password is expired)
- `AllowUnencrypted = true` is removed from Cockpit configuration
- Sudoers and polkit rules are removed
- The SSH denial rule is removed
- The setup service is disabled so it cannot re-run

**Operator responsibility:** Anyone who can reach the device's Cockpit port on the setup network (WiFi AP or Ethernet) during the onboarding window can log in and configure the device. Ensure the setup network segment is physically or logically isolated from untrusted networks.

## Testing

For detailed test environment setup guides, see:

- [Testing WiFi Interfaces](docs/testing-wifi.md) — virtual radios, network namespaces, USB passthrough
- [Testing VLAN Interfaces](docs/testing-vlan.md) — VLAN trunk setup, wizard configuration, reset scripts

## Further Reading

Flight Control documentation (the management platform this plugin enrolls devices into):

- [Introduction & Concepts](https://github.com/flightctl/flightctl/blob/main/docs/user/introduction.md) — core concepts: devices, fleets, agents, labels
- [Enrolling Devices](https://github.com/flightctl/flightctl/blob/main/docs/user/using/managing-devices.md) — the enrollment workflow this plugin facilitates
- [Installing the Agent](https://github.com/flightctl/flightctl/blob/main/docs/user/installing/installing-agent.md) — agent `config.yaml` format and parameters
- [Agent Architecture](https://github.com/flightctl/flightctl/blob/main/docs/user/references/agent-architecture.md) — agent lifecycle states and enrollment flow
- [Certificate Architecture](https://github.com/flightctl/flightctl/blob/main/docs/user/references/certificate-architecture.md) — certificate chain of trust and file locations
- [Building OS Images](https://github.com/flightctl/flightctl/blob/main/docs/user/building/building-images.md) — early vs. late binding enrollment; embedding the agent in bootc images

## License

LGPL 2.1 — see [LICENSE](LICENSE).
