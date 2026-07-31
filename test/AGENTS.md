# Browser Integration Tests

This project uses the [Cockpit test framework](https://github.com/cockpit-project/cockpit/tree/main/test) for browser integration tests. Tests run inside QEMU/KVM virtual machines managed by the `bots/` tooling (checked out via `make bots`).

## Prerequisites

Host packages (Fedora):

```sh
sudo dnf install qemu-kvm libvirt python3-libvirt python3-gssapi \
    python3-pil python3-aiohttp chromium-browser chromedriver
```

Node dependencies (run from repo root):

```sh
npm ci
```

## VM Images

Tests run against QEMU VMs built with `bots/image-customize`. Each image is a qcow2 under `test/images/`.

| Make target          | Image file                          | What it provides                                                                                   |
|----------------------|-------------------------------------|----------------------------------------------------------------------------------------------------|
| `make vm`            | `test/images/$(TEST_OS)`            | Base VM with Cockpit and the onboarding RPM installed from source tarball. Used by `make check`.    |
| `make vm-agent`      | `test/images/$(TEST_OS)`            | Agent/onboarding VM with the pre-built RPM, flightctl agent/CLI from COPR, dnsmasq, and on Fedora mac80211_hwsim (3 simulated radios) and WiFi stack (hostapd, wpa_supplicant). Used by `make check-integration`. |
| `make vm-services`   | `test/images/fedora-43-services`    | Fedora 43 VM with flightctl-services (API, DB, KV, PAM issuer) pre-pulled via podman. Provides a self-contained Flight Control backend for enrollment e2e tests. Always Fedora-based. |
| `make vm-network-services` | `test/images/fedora-43-network-services` | Fedora 43 VM with Squid HTTP proxy and chrony NTP server. Used by network-services e2e tests. Always Fedora-based. |

The `TEST_OS` variable controls which OS is used for the agent VM (default: `fedora-43`). Supported values: `fedora-43`, `centos-9-stream`, `centos-10`. Services VMs are always Fedora-based regardless of `TEST_OS`.

Build images before running tests — they are cached and only rebuilt when install scripts change.

## Running Tests

All commands below are run from the repo root.

### Quick start — nondestructive tests only

Nondestructive tests share a single VM and don't modify its state, so they're fast and safe to iterate on.

```sh
# Build the agent VM (one-time, ~5 min)
make vm-agent

# Run all nondestructive tests from a single file
test/common/run-tests --nondestructive --test-glob 'check-network'

# Run a single test method
test/check-network TestIPConfiguration.testIPv6Toggle
```

Individual tests are fast — each nondestructive test typically completes in 6–10 seconds, and a full file like `check-network` (14 tests) finishes in ~2 minutes. If a single test is taking minutes, there is likely an issue (VM boot hang, missing image, network timeout) that should be investigated rather than waited out.

### Full integration test suite

This is what CI runs. Requires agent, services, and network-services VM images.

```sh
# Build all VM images
make vm-agent vm-services vm-network-services

# Run all integration tests
make check-integration

# With verbose output and parallelism (matches CI)
RUN_TESTS_OPTIONS="-v -j 2" make check-integration
```

### Running against a different OS

```sh
# Build and test on CentOS 9 Stream
TEST_OS=centos-9-stream make vm-agent vm-services vm-network-services
TEST_OS=centos-9-stream make check-integration

# Build and test on CentOS 10
TEST_OS=centos-10 make vm-agent vm-services vm-network-services
TEST_OS=centos-10 make check-integration
```

### Running a single test

```sh
# Run a single e2e test
TEST_OS=centos-9-stream test/check-enrollment-e2e TestEnrollmentE2E.testEndToEndEnrollment

# Run all e2e tests
test/common/run-tests --test-glob 'check-*-e2e'
```

## Test Files

Each `test/check-*` file contains one or more test classes. The table below shows which are nondestructive (safe to run in `--nondestructive` mode) and which require specific VM images.

| File                        | Test class                        | Nondestructive | VM image needed        | OS restriction | Notes                                        |
|-----------------------------|-----------------------------------|:--------------:|------------------------|----------------|----------------------------------------------|
| `check-network`             | `TestNetworkInterface`            | yes            | vm-agent               | all            | Interface list, selection, VLAN              |
| `check-network`             | `TestSingleNic`                   | no             | vm-agent               | all            | Single-NIC mode (adds/removes virtual NICs)  |
| `check-network`             | `TestIPConfiguration`             | yes            | vm-agent               | all            | IPv4/IPv6 method switching, DNS, gateway     |
| `check-network`             | `TestWifi`                        | no             | vm-agent               | fedora-*       | WiFi scan, connect, password (mac80211_hwsim)|
| `check-network`             | `TestDhcpHostname`                | no             | vm-agent               | fedora-*, centos-* | DHCP option 12 hostname pre-population   |
| `check-review`              | `TestReview`                      | yes            | vm-agent               | all            | Review page display and edit navigation      |
| `check-review`              | `TestReviewSingleNic`             | no             | vm-agent               | all            | Review page in single-NIC mode               |
| `check-network-services`    | `TestNtp`                         | yes            | vm-agent               | all            | NTP UI configuration                         |
| `check-network-services`    | `TestProxy`                       | yes            | vm-agent               | all            | Proxy UI configuration                       |
| `check-enrollment`          | `TestEnrollment`                  | yes            | vm-agent               | all            | Enrollment step UI                           |
| `check-labels`              | `TestHostname` / `TestAlias` / `TestCustomLabels` | yes | vm-agent       | all            | Labels/hostname step UI                      |
| `check-apply`               | `TestApplyConfiguration`          | no             | vm-agent               | all            | Full wizard apply (multi-NIC)                |
| `check-apply`               | `TestApplySingleNic` / `TestApplySingleNicRollback` | no | vm-agent     | all            | Apply in single-NIC mode, rollback           |
| `check-apply`               | `TestApplyVlan`                                     | no | vm-agent     | all            | VLAN apply: NM profile, subinterface, connectivity |
| `check-watchdog`            | `TestWatchdog`                    | no             | vm-agent               | all            | Watchdog timer configuration                 |
| `check-status-hook`         | `TestStatusHook`                  | no             | vm-agent               | all            | Status hook lifecycle (multi-NIC)            |
| `check-status-hook`         | `TestStatusHookSingleNic`         | no             | vm-agent               | all            | Status hook lifecycle (single-NIC)           |
| `check-enrollment-e2e`      | `TestEnrollmentE2E` / `TestEnrollmentE2ESingleNic` | no | vm-agent + vm-services | all    | Full enrollment against flightctl backend    |
| `check-network-services-e2e`| `TestNtpE2E` / `TestProxyE2E`    | no             | vm-agent + vm-network-services | all    | NTP/proxy applied and verified in NM         |
| `check-network-services-e2e`| `TestEnrollmentThroughProxyE2E`   | no             | vm-agent + vm-network-services + vm-services | all | Enrollment through proxy          |

## Test Architecture

- **`test/common/`** — Cockpit's shared test library (`testlib.py`, `run-tests`, etc.), checked out from upstream via `make bots`.
- **`test/wizard_navigation.py`** — Shared helpers for navigating the onboarding wizard (step advancement, button clicks, interface selection).
- **`test/vm.install`** — Base VM setup (Cockpit socket, firewall).
- **`test/vm-agent.install`** — Agent/onboarding VM: pre-built RPM, flightctl agent, dnsmasq, and on Fedora mac80211_hwsim + infra AP scripts.
- **`test/vm-flightctl-services.install`** — Services VM: flightctl-services via COPR, DNS, PAM user, container pre-pull.
- **`test/vm-network-services.install`** — Network services VM: Squid proxy and chrony NTP server.
- **`test/browser/`** — CI entry point scripts for Testing Farm (TMT).

## Troubleshooting

- **"no chromium binary found"** — Install chromium: `sudo dnf install chromium-browser chromedriver`
- **VM boot hangs** — Check KVM access: `ls -la /dev/kvm`. Your user needs to be in the `kvm` group or the device needs mode 0666.
- **"image not found"** — Run the appropriate `make vm-*` target to build the image first.
- **Stale VM image** — Delete `test/images/<image-name>*` and rebuild to pick up install script changes.
- **No output during test run** — Always set `PYTHONUNBUFFERED=1` in your environment.
