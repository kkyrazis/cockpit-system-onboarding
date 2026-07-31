# AGENTS.md — Development Guide

## Project Overview

Flightctl Onboarding is a Cockpit plugin that provides a first-boot setup wizard for headless Linux devices. It configures networking, enrolls the device into Flight Control, and then disables itself.

**Tech stack**: React 18, TypeScript, PatternFly 6, esbuild, Cockpit JS API. Backend logic is in bash scripts invoked via `cockpit.spawn()`. Packaging is RPM via a spec file.

## Build and Test Commands

| Command | Purpose |
|---------|---------|
| `make` | Build the project (esbuild, outputs to `dist/`) |
| `make watch` | Build + watch for changes with live reload |
| `make rpm` | Build the RPM package |
| `make codecheck` | Run ESLint, Stylelint, and TypeScript type checking |
| `npm test` | Run Jest unit tests |
| `make check` | Run browser integration tests (requires test VM) |
| `make deploy-test-vm` | Create a Fedora test VM with WiFi simulation |
| `make devel-install` | Symlink `dist/` into local Cockpit for development |

## Project Structure

```
src/                          React/TypeScript source
  app.tsx                     Main wizard component and flow orchestration
  wizard/                     Wizard step components (one per page)
  services/                   Cockpit API wrappers (D-Bus, spawn, file I/O)
  hooks/                      React hooks (connected-interface detection)
  __tests__/                  Jest unit tests

packaging/
  systemd/                    Systemd service units
    scripts/                  Shell scripts for setup, cleanup, enrollment, rollback
  system-onboarding.d/        Enrollment drop-in scripts (flightctl-enroll.sh)
  polkit/                     Polkit rules for the onboarding user
  sudoers.d/                  Sudoers rules for privileged operations
  overrides/                  Cockpit module override files (hide shell chrome)

flightctl-onboarding.spec     Generated RPM spec
packaging/flightctl-onboarding.spec.in   Spec template
```

## Architecture

### Config loading

Three-tier hierarchy (highest priority first):

1. **Operator override**: `/etc/cockpit/system-onboarding/config.json`
2. **Package default**: `/usr/share/cockpit/system-onboarding/config.json`
3. **Built-in defaults**: hardcoded in `src/config-loader.ts`

Shell scripts use `load_config` from `packaging/systemd/scripts/common.sh` which reads the same two JSON files via `jq`.

### Privilege model

The `onboarding` user is unprivileged. All system modifications use one of:

- **D-Bus via Cockpit** — hostname, NTP, NetworkManager operations. Authorized by polkit rules in `packaging/polkit/49-flightctl-onboarding.rules`.
- **sudo via cockpit.spawn()** — enrollment scripts, file writes, arping, systemctl. Authorized by sudoers rules in `packaging/sudoers.d/flightctl-onboarding`.

### State files

| File | Purpose |
|------|---------|
| `/var/lib/flightctl-onboarding/.onboarding-complete` | Written by `finalize-onboarding.sh` after successful enrollment. Prevents the setup service from re-running. |
| `/var/lib/flightctl-onboarding/.onboarding-confirmed` | Written by `cleanup-onboarding.sh`. Gates `flightctl-agent.service` startup via `ConditionPathExists`. |
| `/var/lib/flightctl-onboarding/.onboarding-attempted` | Written by the wizard before apply. Persists wizard state for retry after failure. |
| `/var/lib/flightctl-onboarding/.watchdog-active` | Written when the watchdog timer is armed. Read by `watchdog-rollback.sh`. |
| `/var/lib/flightctl-onboarding/.watchdog-status` | Written by watchdog/apply scripts to communicate status (`success`, `app_failure`, `network_failure`). Polled by the wizard UI. |

## Two Supported Flows

The wizard supports two operational flows. The choice is automatic — it depends on whether the network interface the operator is configuring is the same one carrying their browser session.

### Inline flow (multi-NIC)

The operator connects to Cockpit via one interface (e.g. the WiFi AP or a dedicated setup Ethernet port) and configures a **different** interface for production use.

**Sequence:**

1. Wizard collects all configuration (hostname, labels, network, NTP, proxy, enrollment credentials).
2. Operator clicks Apply on the review screen.
3. A watchdog timer is armed (240s for WiFi, 600s for Ethernet).
4. The wizard detects that the selected interface is **not** the connected one → inline flow.
5. Steps execute sequentially **in the browser session** via `cockpit.spawn()` and D-Bus:
   - Apply configuration (hostname, create and activate NM connection profile, NTP, proxy, device labels)
   - Test connectivity (DNS resolution + ping)
   - Run enrollment script (passes credentials via temp file, streams progress)
   - Finalize (write `.onboarding-complete` marker)
6. On success: wizard shows results. Operator clicks "Finish" → `cleanup-onboarding.sh` runs.
7. On failure: `rollback-config.sh` reverts changes. Wizard shows the error. Operator can go back, fix settings, and retry.

**Key characteristic**: the browser session is never interrupted. The operator sees real-time progress for every step.

### Single-NIC flow (background delegation)

The operator connects and configures the **same** interface — e.g. connecting via the setup Ethernet and configuring that same Ethernet for production. Activating the new NM profile will sever the browser connection.

**Sequence:**

1. Wizard collects all configuration. A warning alert is shown: "Applying network changes to this interface will disconnect your browser session."
2. Operator clicks Apply.
3. Watchdog timer is armed.
4. The wizard detects that the selected interface **is** the connected one → single-NIC flow.
5. **In-process steps** (before handoff):
   - Apply hostname and NTP (skip network activation)
   - Create the NM connection profile **without activating it**
   - Write enrollment params to a secure temp file
6. **Delegate to systemd**: `run-apply-enroll.sh` calls `systemd-run --no-block` to launch a transient unit (`flightctl-onboarding-apply-*`). This unit survives the cockpit-bridge exit that occurs when the browser disconnects.
7. Wizard marks remaining steps as "delegated" and shows an info banner: "Onboarding continues in the background."
8. **Background execution** (in the transient systemd unit via `apply-and-enroll.sh`):
   - Stop onboarding network services (WiFi AP, dnsmasq)
   - `nmcli connection up` — browser connection is lost at this point
   - Wait for carrier (up to 5 minutes for Ethernet — time for the operator to move the cable)
   - Test connectivity (retries at 5s intervals within `connectivityTimeoutSeconds` budget)
   - Run enrollment script
   - Finalize → cleanup (remove user, stop AP, start flightctl-agent)
9. **Meanwhile in the browser** (if still open or reconnected):
   - Polls every 3s for the completion marker → reloads to show "Onboarding complete"
   - Polls for watchdog `app_failure` status → shows enrollment error in the UI
10. **If the background flow fails**:
    - Enrollment failure with working network: watchdog writes `app_failure`, keeps network config. UI shows the error when polled.
    - Network failure (no carrier/DNS after timeout): watchdog rolls back network config, restores the setup interface, re-enables the setup service. Operator can reconnect and retry.

**Key characteristic**: the browser session is lost when the network profile activates. The `systemd-run` wrapper and watchdog timer ensure the process either completes or rolls back without operator intervention.

### How single-NIC detection works

`src/services/network.ts` → `isConnectedViaInterface()`:

1. If the browser is at `localhost`, returns `false` (local console — never single-NIC).
2. Reads the Cockpit port from `/etc/cockpit/cockpit.conf` (default `9090`), then runs `ss -Htn sport = :<port>` to find the IP addresses of active Cockpit sessions.
3. Runs `ip -o addr show <selectedInterface>` to get addresses on the selected interface.
4. If any session IP matches an interface IP, the operator is connected through that interface → single-NIC.

## Key Scripts Reference

All scripts are in `packaging/systemd/scripts/` unless noted otherwise.

| Script | Purpose |
|--------|---------|
| `common.sh` | Shared functions: config loading, interface detection, DHCP range calculation |
| `create-onboarding-user.sh` | Creates the `onboarding` user, sets password from config, configures Cockpit `AllowUnencrypted` |
| `setup-network.sh` | Creates the setup Ethernet NM connection with static IP, optionally starts dnsmasq for DHCP |
| `setup-wifi-ap.sh` | Generates hostapd/dnsmasq configs, creates firewalld zone, starts the WiFi AP services |
| `cleanup-onboarding.sh` | Full teardown: remove user, stop AP, delete setup NM profile, write agent gate file, start flightctl-agent |
| `finalize-onboarding.sh` | Writes the `.onboarding-complete` marker with timestamp and hostname |
| `run-apply-enroll.sh` | Sudo wrapper that launches `apply-and-enroll.sh` via `systemd-run --no-block` |
| `apply-and-enroll.sh` | Background apply sequence for single-NIC: activate network, wait for connectivity, enroll, finalize, cleanup |
| `run-watchdog.sh` | Arms a transient systemd timer that fires `watchdog-rollback.sh` after a timeout |
| `watchdog-rollback.sh` | Timeout handler: checks connectivity, either reports `app_failure` or rolls back network and re-enters setup mode |
| `rollback-config.sh` | Reverts network, hostname, NTP, proxy, and label changes from a rollback manifest |
| `check-network.sh` | Runs arping for duplicate IP detection or carrier checks (called from the wizard UI) |
| `check-dependencies.sh` | Validates required and optional dependencies at service startup |
| `configure-ntp.sh` | Writes NTP server configuration via chrony or timesyncd drop-ins |
| `apply-proxy.sh` | Writes proxy settings to systemd drop-in and `/etc/environment`, runs `daemon-reexec` |
| `apply-labels.sh` | Writes device labels to `/etc/flightctl/conf.d/50-cockpit-labels.yaml` |
| `read-flightctl-config.sh` | Reads `/etc/flightctl/config.yaml` to detect existing enrollment credentials |
| `setup-status-hook.sh` | Invokes the user-provided status hook with `ready` state at boot (when `statusHook.enabled` is `true`) |
| `wifi-ap-prepare.sh` | Releases the WiFi interface from NetworkManager before hostapd takes over |
| `wifi-ap-activate.sh` | Assigns the AP IP address, starts dnsmasq/captive portal, and adds the interface to the firewalld zone |
| `wifi-ap-teardown.sh` | Removes the interface from the firewalld zone, flushes addresses, and brings the interface down |
| `mask-greenboot.sh` | Masks greenboot-healthcheck.service during onboarding to prevent OS rollback while flightctl-agent is gated |
| `captive-portal.py` | HTTP captive portal responder: handles OS-specific detection probes and redirects clients to the Cockpit wizard |
| `packaging/system-onboarding.d/flightctl-enroll.sh` | Flight Control enrollment: reads credentials from temp file, runs `flightctl login` + `flightctl certificate request` |

## Coding Conventions

### TypeScript / React

- PatternFly 6 components for all UI elements
- Cockpit JS API for D-Bus (`cockpit.dbus()`), process spawning (`cockpit.spawn()`), and file I/O (`cockpit.file()`)
- System commands run via `cockpit.spawn(["sudo", scriptPath, ...args])` — never via `cockpit.spawn({ superuser: "require" })`
- Validated form inputs use the `ValidatedTextInput` component pattern
- Wizard state is lifted to `app.tsx` and passed down as props

### Shell scripts

- All scripts source `common.sh` for shared config loading and utilities
- Idempotent operations — re-running any script after partial completion must not produce errors
- Error handling via `set -euo pipefail` and `trap` for cleanup on failure
- NM connection profiles created by the wizard use the `flightctl-onboarding-` prefix for easy identification during rollback
- Temp files for credentials use mode `0600` and are deleted immediately after reading

### Testing

- Unit tests: Jest with `@testing-library/react` for component tests
- Integration tests: Cockpit's browser test framework (`make check`)
- Test VM: `make deploy-test-vm` creates a Fedora VM with virtual WiFi radios and VLAN trunk support
