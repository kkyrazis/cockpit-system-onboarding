# Bootc Image Test Plan

## Hardware

- 1x Raspberry Pi 4 (agent — swap SD cards for different roles)
- 1x Fedora laptop (flightctl server + NTP at `192.168.8.10`)
- 1x Windows laptop (provisioning — accesses Cockpit on the Pi)
- Travel router (subnet `192.168.8.0/24`, gateway `192.168.8.1`, no internet)
- Powered unmanaged switch
- 3x SD cards pre-flashed with bootc images
- Monitor + keyboard (for headful tests)

## SD Card Assignments

| Size | Image | Role |
|------|-------|------|
| 64GB | headless-ethernet | Agent, operator accesses via direct ethernet |
| 128GB | headless-wifi | Agent, operator accesses via WiFi AP |
| 256GB | headful-ethernet | Agent, operator accesses via kiosk monitor |

## Network Topology

```
[Router: 192.168.8.1] (WiFi AP, no internet)
  └── Ethernet
        └── [Switch]
              ├── Fedora laptop (flightctl + NTP, static 192.168.8.10)
              ├── Agent Pi (ethernet, plugged in for ethernet tests only)
              └── Windows laptop (provisioning)
```

The Fedora laptop runs flightctl services and chrony NTP on `192.168.8.10`,
connected to the switch via ethernet. The travel router provides a WiFi AP on
the same `192.168.8.0/24` subnet with no internet uplink.

For WiFi access tests, the Pi's ethernet cable is unplugged. The Pi creates a
WiFi AP for operator access, then the onboarding UI configures the target
interface to reach the flightctl server.

For ethernet access tests, the Pi's ethernet cable is plugged into the switch.
The Windows laptop uses a static IP to reach the Pi's ethernet interface.

The CA is not pre-provisioned on agent images. The onboarding UI's TLS
verification options handle untrusted certificates during enrollment.

## Prerequisites

1. Flash three SD cards using `build-images.sh` output
2. On the Fedora laptop:
   - Assign static IP `192.168.8.10/24` on the ethernet interface
   - Start flightctl services via podman
   - Start chrony configured to serve time on `192.168.8.0/24`
3. Connect the Fedora laptop and travel router to the switch
4. Boot the travel router, note WiFi SSID and password
5. Verify from Windows laptop: can ping `192.168.8.10`

## Test Execution

### Phase 1: WiFi access tests (Pi ethernet unplugged)

The Windows laptop joins the Pi's WiFi AP to access Cockpit.

---

**Test A — WiFi access, configure WiFi**

- Card: 128GB (headless-wifi)
- Operator access: Windows laptop joins Pi's WiFi AP, opens `http://10.42.0.1:9090`
- Target interface: WiFi → travel router

Steps:
1. Insert 128GB card into Pi, boot (ethernet unplugged)
2. On Windows laptop, join the Pi's `flightctl-*` WiFi AP
3. Open `http://10.42.0.1:9090` in a browser
4. In the onboarding UI, configure WiFi to connect to the travel router's SSID
5. Set the enrollment endpoint to `https://192.168.8.10:3443`
6. Skip or accept the untrusted CA certificate
7. Verify the connectivity test passes (Pi reaches `192.168.8.10` via router → switch)
8. Complete enrollment
9. Verify on the Fedora laptop: `flightctl get devices`

Expected: Pi joins router WiFi, gets a DHCP address on `192.168.8.x`, reaches
the laptop through the router and switch, enrolls successfully.

---

**Test B — WiFi access, configure ethernet**

- Card: 128GB (headless-wifi)
- Operator access: Windows laptop joins Pi's WiFi AP, opens `http://10.42.0.1:9090`
- Target interface: Ethernet static IP

Steps:
1. Insert 128GB card into Pi, plug ethernet into switch, boot
2. On Windows laptop, join the Pi's `flightctl-*` WiFi AP
3. Open `http://10.42.0.1:9090` in a browser
4. In the onboarding UI, configure the ethernet interface with a static IP:
   - IP: `192.168.8.20/24`
   - Gateway: `192.168.8.1`
5. Set the enrollment endpoint to `https://192.168.8.10:3443`
6. Skip or accept the untrusted CA certificate
7. Verify the connectivity test passes (Pi reaches `192.168.8.10` via ethernet)
8. Complete enrollment
9. Verify on the Fedora laptop: `flightctl get devices`

Expected: Pi's ethernet gets a static IP on the switch subnet. WiFi AP stays
up for operator access. Enrollment succeeds via ethernet.

---

### Phase 2: Ethernet access tests (Pi ethernet plugged in)

The Windows laptop uses a static IP to reach the Pi's ethernet interface.

---

**Test C — Ethernet access, configure WiFi**

- Card: 64GB (headless-ethernet)
- Operator access: Windows laptop at `http://192.168.100.1:9090`
- Target interface: WiFi → travel router

Steps:
1. Insert 64GB card into Pi, plug ethernet into switch, boot
2. On Windows laptop, configure a static IP to reach the Pi:
   - IP: `192.168.100.2/24` on the ethernet adapter
3. Open `http://192.168.100.1:9090` in a browser
4. In the onboarding UI, configure WiFi to connect to the travel router's SSID
5. Set the enrollment endpoint to `https://192.168.8.10:3443`
6. Skip or accept the untrusted CA certificate
7. Verify the connectivity test passes (Pi reaches `192.168.8.10` via router → switch)
8. Complete enrollment
9. Verify on the Fedora laptop: `flightctl get devices`

Expected: Pi joins router WiFi while ethernet stays at `192.168.100.1`.
Operator retains Cockpit access throughout. Enrollment succeeds via WiFi.

Cleanup: Remove static IP from Windows laptop.

---

**Test D — Ethernet access, configure ethernet**

- Card: 64GB (headless-ethernet)
- Operator access: Windows laptop at `http://192.168.100.1:9090`
- Target interface: Ethernet static IP

Steps:
1. Insert 64GB card into Pi, plug ethernet into switch, boot
2. On Windows laptop, configure a static IP to reach the Pi:
   - IP: `192.168.100.2/24` on the ethernet adapter
3. Open `http://192.168.100.1:9090` in a browser
4. In the onboarding UI, reconfigure the ethernet interface:
   - IP: `192.168.8.20/24`
   - Gateway: `192.168.8.1`
5. Set the enrollment endpoint to `https://192.168.8.10:3443`
6. Skip or accept the untrusted CA certificate
7. **The operator will lose Cockpit access** when the IP changes from
   `192.168.100.1` to `192.168.8.20` — enrollment must complete as part of
   the same action before the IP change takes effect, OR the operator
   reconnects at the new IP
8. Verify on the Fedora laptop: `flightctl get devices`

Expected: This is the hardest test. The operator's connection drops when the
ethernet IP changes. Verify the onboarding UI handles this gracefully — either
enrollment completes before the IP change, or the UI instructs the operator to
reconnect at the new address.

Cleanup: Remove static IP from Windows laptop.

---

### Phase 3: Kiosk tests

The Pi has a monitor and keyboard attached. Cockpit runs in a kiosk browser.

---

**Test E — Kiosk access, configure WiFi**

- Card: 256GB (headful-ethernet)
- Operator access: monitor + keyboard, kiosk Firefox at `https://localhost:9090`
- Target interface: WiFi → travel router

Steps:
1. Insert 256GB card into Pi, connect monitor and keyboard, boot (ethernet unplugged)
2. Wait for kiosk to launch on tty7
3. Accept the certificate warning if prompted
4. In the onboarding UI, configure WiFi to connect to the travel router's SSID
5. Set the enrollment endpoint to `https://192.168.8.10:3443`
6. Skip or accept the untrusted CA certificate
7. Verify the connectivity test passes
8. Complete enrollment
9. Verify on the Fedora laptop: `flightctl get devices`

Expected: Pi joins router WiFi. Kiosk access unaffected throughout.

---

**Test F — Kiosk access, configure ethernet**

- Card: 256GB (headful-ethernet)
- Operator access: monitor + keyboard, kiosk at `https://localhost:9090`
- Target interface: Ethernet static IP

Steps:
1. Insert 256GB card into Pi, connect monitor, keyboard, and ethernet, boot
2. Wait for kiosk to launch
3. In the onboarding UI, configure the ethernet interface with a static IP:
   - IP: `192.168.8.20/24`
   - Gateway: `192.168.8.1`
4. Set the enrollment endpoint to `https://192.168.8.10:3443`
5. Skip or accept the untrusted CA certificate
6. Verify the connectivity test passes
7. Complete enrollment
8. Verify on the Fedora laptop: `flightctl get devices`

Expected: Ethernet gets static IP. Kiosk access unaffected (localhost).

---

## Verifying Enrollment

On the Fedora laptop after each test:

```bash
flightctl get devices
```

Each enrolled agent should appear with a unique device ID. To reset an agent
for re-testing, remove the enrollment state and reboot:

```bash
ssh testadmin@<agent-ip>
sudo rm -rf /var/lib/flightctl
sudo rm -f /var/lib/flightctl-onboarding/.onboarding-complete
sudo reboot
```

## Results Tracking

| Test | Access Method | Configures | Pi Ethernet | Result | Notes |
|------|--------------|------------|-------------|--------|-------|
| A | WiFi AP | WiFi → router | Unplugged | | |
| B | WiFi AP | Ethernet static | Plugged in | | |
| C | Ethernet | WiFi → router | Plugged in | | |
| D | Ethernet | Ethernet static | Plugged in | | |
| E | Kiosk | WiFi → router | Unplugged | | |
| F | Kiosk | Ethernet static | Plugged in | | |
