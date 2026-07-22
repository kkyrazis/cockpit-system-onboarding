import cockpit from "cockpit";
import { Interface, NetworkManagerModel } from "../../pkg/networkmanager/interfaces.js";
import { Model } from "../model-context";
import { ONBOARDING_PROFILE_PREFIX } from "../paths";
import { waitForProxy, waitForProxyWithTimeout } from "./dbus-helpers";
import { ipv6ToBytes } from "./network-utils";
import { WifiSecurity } from "../types.js";
import {
    indexedActionId,
    makeStepAction,
    type ActionResult,
    type StepAction,
} from "../wizard/enrollment-progress-types";

export interface NetworkApplyResult {
    actions: StepAction[];
}

const NETWORK_ACTION_PREFIX = "config-network";

function pushNetworkAction(actions: StepAction[], actionTitle: string, result: ActionResult = "success"): void {
    actions.push(makeStepAction(indexedActionId(NETWORK_ACTION_PREFIX, actions.length), actionTitle, result));
}

export interface ConnectionIpSettings {
    method?: string;
    dns?: string[];
    "may-fail"?: boolean;
}

interface NmDbusVariant<T = unknown> {
    v?: T;
}

interface NmConnectionSettings {
    connection?: {
        id?: NmDbusVariant<string> | string;
    };
}

type ActiveConnectionProxy = cockpit.DBusProxy & {
    wait(callback?: () => void): void;
    State?: number;
};

function dbusPathResult(result: unknown[]): string {
    const value = result[0];
    return typeof value === "string" ? value : "/";
}

function dbusPathListResult(result: unknown[]): string[] {
    const value = result[0];
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((path): path is string => typeof path === "string");
}

function isLocalhost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

const COCKPIT_WS_DEFAULT_PORT = "9090";
const COCKPIT_CONF_PATH = "/etc/cockpit/cockpit.conf";

let cachedCockpitWsPort: string | null = null;

async function getCockpitWsPort(): Promise<string> {
    if (cachedCockpitWsPort !== null) {
        return cachedCockpitWsPort;
    }

    let port = COCKPIT_WS_DEFAULT_PORT;
    try {
        const content = await cockpit.file(COCKPIT_CONF_PATH).read();
        if (content) {
            const match = content.match(/^\s*Port\s*=\s*(\d+)/m);
            if (match) {
                port = match[1];
            }
        }
    } catch {
        // Config file may not exist
    }

    cachedCockpitWsPort = port;
    return port;
}

export function mapWifiSecurity(security: string): WifiSecurity {
    switch (security) {
        case "None":
            return "none";
        case "WEP":
            return "wep";
        default:
            // WPA, WPA2, WPA3, or any combination -> 'wpa'
            return "wpa";
    }
}

function normalizeIpv6(addr: string): string {
    const mappedMatch = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mappedMatch) {
        return mappedMatch[1];
    }
    return addr.replace(/%.*$/, "");
}

function parseLocalAddressFromSsLine(line: string): string | null {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) {
        return null;
    }
    const localAddrPort = fields[3];
    let addr: string;
    if (localAddrPort.startsWith("[")) {
        addr = localAddrPort.replace(/^\[/, "").replace(/\]:\d+$/, "");
    } else {
        addr = localAddrPort.replace(/:\d+$/, "");
    }
    if (!addr || addr === "*") {
        return null;
    }
    return normalizeIpv6(addr);
}

function parseAddressFromIpAddrLine(line: string): string | null {
    const match = line.match(/\s+inet6?\s+([^\s/]+)/);
    if (!match) {
        return null;
    }
    return normalizeIpv6(match[1]);
}

export async function isConnectedViaInterface(ifaceName: string): Promise<boolean> {
    if (isLocalhost(window.location.hostname)) {
        return false;
    }

    const port = await getCockpitWsPort();

    let cockpitLocalAddrs: Set<string>;
    try {
        const ssOutput = await cockpit.spawn(
            ["ss", "-Htn", "sport", "=", `:${port}`],
            { err: "message" }
        );
        cockpitLocalAddrs = new Set(
            ssOutput.split("\n")
                .map(parseLocalAddressFromSsLine)
                .filter((a): a is string => a !== null)
        );
    } catch (error) {
        console.warn("Failed to query cockpit-ws connections:", error);
        return false;
    }

    if (cockpitLocalAddrs.size === 0) {
        return false;
    }

    let ifaceAddrs: Set<string>;
    try {
        const ipOutput = await cockpit.spawn(
            ["ip", "-o", "addr", "show", ifaceName],
            { err: "message" }
        );
        ifaceAddrs = new Set(
            ipOutput.split("\n")
                .map(parseAddressFromIpAddrLine)
                .filter((a): a is string => a !== null)
        );
    } catch (error) {
        console.warn("Failed to query interface addresses:", error);
        return false;
    }

    for (const addr of cockpitLocalAddrs) {
        if (ifaceAddrs.has(addr)) {
            return true;
        }
    }

    return false;
}

export async function getDefaultInterface(interfaces: Interface[]): Promise<string | null> {
    try {
        const result = await cockpit.spawn(["ip", "route", "show", "default"], { err: "message" });
        const lines = result.split("\n");

        for (const line of lines) {
            const match = line.match(/default via .+ dev (\S+)/);
            if (match) {
                const interfaceName = match[1];
                const found = interfaces.find((iface) => iface.Name === interfaceName);
                if (found) {
                    return interfaceName;
                }
            }
        }
    } catch (error) {
        console.warn("Failed to get default route:", error);
    }

    try {
        const result = await cockpit.spawn(["ip", "-6", "route", "show", "default"], { err: "message" });
        const lines = result.split("\n");

        for (const line of lines) {
            const match = line.match(/default via .+ dev (\S+)/);
            if (match) {
                const interfaceName = match[1];
                const found = interfaces.find((iface) => iface.Name === interfaceName);
                if (found) {
                    return interfaceName;
                }
            }
        }
    } catch (error) {
        console.warn("Failed to get default IPv6 route:", error);
    }

    // Fallback: find first active interface
    const activeInterface = interfaces.find(
        (iface) => iface.Device && iface.Device.State === 100 // NM_DEVICE_STATE_ACTIVATED
    );

    return activeInterface ? activeInterface.Name : null;
}

const DHCP4_HOSTNAME_KEY = "host_name";
const DHCP6_FQDN_KEY = "fqdn_fqdn";

export async function getDhcpHostname(interfaces: Interface[]): Promise<string> {
    try {
        const defaultIface = await getDefaultInterface(interfaces);
        if (!defaultIface) return "";

        const iface = interfaces.find((i) => i.Name === defaultIface);
        if (!iface?.Device?.ActiveConnection) return "";

        const ipv4Settings = iface.MainConnection?.Settings.ipv4 as ConnectionIpSettings | undefined;
        const ipv6Settings = iface.MainConnection?.Settings.ipv6 as ConnectionIpSettings | undefined;
        const ipv4Method = ipv4Settings?.method;
        const ipv6Method = ipv6Settings?.method;

        if (ipv4Method === "manual" && (ipv6Method === "manual" || ipv6Method === "ignore" || ipv6Method === "disabled")) {
            return "";
        }

        const nmClient = cockpit.dbus("org.freedesktop.NetworkManager");
        try {
            const [devicePath] = await nmClient.call(
                "/org/freedesktop/NetworkManager",
                "org.freedesktop.NetworkManager",
                "GetDeviceByIpIface",
                [defaultIface]
            );

            const deviceProxy = await waitForProxyWithTimeout(
                nmClient.proxy("org.freedesktop.NetworkManager.Device", devicePath),
                2000
            );

            if (ipv4Method !== "manual" && deviceProxy.data.Dhcp4Config && deviceProxy.data.Dhcp4Config !== "/") {
                const dhcp4Proxy = await waitForProxyWithTimeout(
                    nmClient.proxy("org.freedesktop.NetworkManager.DHCP4Config", deviceProxy.data.Dhcp4Config),
                    2000
                );
                const options = dhcp4Proxy.data.Options || {};
                if (options[DHCP4_HOSTNAME_KEY]) return options[DHCP4_HOSTNAME_KEY];
            }

            if (ipv6Method !== "manual" && ipv6Method !== "ignore" && ipv6Method !== "disabled"
                && deviceProxy.data.Dhcp6Config && deviceProxy.data.Dhcp6Config !== "/") {
                const dhcp6Proxy = await waitForProxyWithTimeout(
                    nmClient.proxy("org.freedesktop.NetworkManager.DHCP6Config", deviceProxy.data.Dhcp6Config),
                    2000
                );
                const options = dhcp6Proxy.data.Options || {};
                if (options[DHCP6_FQDN_KEY]) return options[DHCP6_FQDN_KEY];
            }

            return "";
        } finally {
            nmClient.close();
        }
    } catch (error) {
        console.warn("Could not retrieve DHCP hostname:", error);
        return "";
    }
}

export function subnetMaskToPrefixLength(subnetMask: string): number {
    const parts = subnetMask.split(".").map(Number);
    if (parts.length !== 4) {
        return 24;
    }

    let prefixLength = 0;
    for (const part of parts) {
        prefixLength += part.toString(2).split("1").length - 1;
    }
    return prefixLength;
}

export function parseIpv6Address(addressWithPrefix: string): { address: string; prefix: number } {
    if (!addressWithPrefix) {
        return { address: "", prefix: 64 };
    }

    const parts = addressWithPrefix.split("/");
    const address = parts[0] || "";
    const prefix = parts[1] ? parseInt(parts[1], 10) : 64;

    return { address, prefix };
}

interface VlanInfo {
    isVlan: boolean;
    effectiveIfaceName: string;
}

function resolveVlanInfo(
    ifaceName: string,
    interfaceType: string,
    vlanEnabled: boolean,
    vlanId: number | null
): VlanInfo {
    const isVlan = vlanEnabled && vlanId !== null && interfaceType !== "wifi";
    const effectiveIfaceName = isVlan ? `${ifaceName}.${vlanId}` : ifaceName;
    return { isVlan, effectiveIfaceName };
}

function waitForActivation(nmClient: cockpit.DBusClient, activeConnPath: string): Promise<void> {
    const NM_ACTIVE_CONNECTION_STATE_ACTIVATED = 2;
    const NM_ACTIVE_CONNECTION_STATE_DEACTIVATED = 4;
    const TIMEOUT_MS = 30000;
    const POLL_MS = 500;

    return new Promise((resolve, reject) => {
        const proxy = nmClient.proxy(
            "org.freedesktop.NetworkManager.Connection.Active",
            activeConnPath
        ) as ActiveConnectionProxy;

        let timer: ReturnType<typeof setTimeout> | null = null;
        let pollInterval: ReturnType<typeof setInterval> | null = null;

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
            }
            if (pollInterval) {
                clearInterval(pollInterval);
            }
        };

        timer = setTimeout(() => {
            cleanup();
            resolve();
        }, TIMEOUT_MS);

        proxy.wait(() => {
            if (!proxy.valid) {
                cleanup();
                resolve();
                return;
            }

            const checkState = () => {
                const state = proxy.State;
                if (state === NM_ACTIVE_CONNECTION_STATE_ACTIVATED) {
                    cleanup();
                    resolve();
                } else if (state === NM_ACTIVE_CONNECTION_STATE_DEACTIVATED) {
                    cleanup();
                    reject(new Error("Connection activation failed"));
                }
            };

            checkState();
            pollInterval = setInterval(checkState, POLL_MS);
        });
    });
}

function buildConnectionSettings(
    model: Model,
    ifaceName: string,
    interfaceType: string
): Record<string, Record<string, unknown>> {
    const vlanId = model.networkInterface.vlanId;
    const { isVlan, effectiveIfaceName } = resolveVlanInfo(
        ifaceName,
        interfaceType,
        model.networkInterface.vlanEnabled,
        vlanId
    );
    const connectionId = `${ONBOARDING_PROFILE_PREFIX}${effectiveIfaceName}`;

    const nmType = isVlan ? "vlan" : interfaceType === "wifi" ? "802-11-wireless" : "802-3-ethernet";

    const settings: Record<string, Record<string, unknown>> = {
        connection: {
            id: { t: "s", v: connectionId },
            type: { t: "s", v: nmType },
            "interface-name": { t: "s", v: effectiveIfaceName },
            autoconnect: { t: "b", v: true },
            "autoconnect-priority": { t: "i", v: 999 },
        },
    };

    if (isVlan) {
        settings.vlan = {
            id: { t: "u", v: vlanId },
            parent: { t: "s", v: ifaceName },
        };
        settings["802-3-ethernet"] = {};
    } else if (nmType === "802-3-ethernet") {
        settings["802-3-ethernet"] = {};
    } else if (nmType === "802-11-wireless") {
        const ssid = model.networkInterface.wifiSsid || "";
        // NM expects SSID as 'ay' (array of bytes). Cockpit's D-Bus bridge
        // accepts base64-encoded strings for 'ay' values.
        const ssidBase64 = btoa(ssid);
        settings["802-11-wireless"] = {
            ssid: { t: "ay", v: ssidBase64 },
            mode: { t: "s", v: "infrastructure" },
        };

        if (model.networkInterface.wifiBand && model.networkInterface.wifiBand !== "auto") {
            settings["802-11-wireless"].band = { t: "s", v: model.networkInterface.wifiBand };
        }

        if (
            model.networkInterface.wifiSecurity !== "none" &&
            (model.networkInterface.wifiSecurity || model.networkInterface.wifiPassword)
        ) {
            settings["802-11-wireless"].security = { t: "s", v: "802-11-wireless-security" };
            settings["802-11-wireless-security"] = {
                "key-mgmt": { t: "s", v: "wpa-psk" },
                psk: { t: "s", v: model.networkInterface.wifiPassword || "" },
            };
        }
    }

    // IPv4 settings
    if (model.networkAddress.ipv4.method === "static") {
        const prefixLength = model.networkAddress.ipv4.subnetMask
            ? subnetMaskToPrefixLength(model.networkAddress.ipv4.subnetMask)
            : 24;

        const addressData = [
            {
                address: { t: "s", v: model.networkAddress.ipv4.address || "" },
                prefix: { t: "u", v: prefixLength },
            },
        ];

        const dnsServers = [model.networkAddress.ipv4.primaryDns, model.networkAddress.ipv4.secondaryDns].filter(
            (dns) => dns && dns.trim()
        ) as string[];

        // Convert DNS to uint32 (NM D-Bus format for ipv4.dns)
        const dnsUint32 = dnsServers.map((ip) => {
            const parts = ip.split(".").map(Number);
            // NM uses little-endian uint32 for IPv4 DNS
            return parts[0] | (parts[1] << 8) | (parts[2] << 16) | (parts[3] << 24);
        });

        settings.ipv4 = {
            method: { t: "s", v: "manual" },
            "address-data": { t: "aa{sv}", v: addressData },
            gateway: { t: "s", v: model.networkAddress.ipv4.gateway || "" },
            dns: { t: "au", v: dnsUint32 },
            "ignore-auto-dns": { t: "b", v: !model.networkAddress.ipv4.autoDns },
        };
    } else if (model.networkAddress.ipv4.method === "disabled") {
        settings.ipv4 = {
            method: { t: "s", v: "disabled" },
        };
    } else {
        settings.ipv4 = {
            method: { t: "s", v: "auto" },
        };
    }

    // IPv6 settings
    if (model.networkAddress.ipv6.method === "static") {
        let ipv6AddressData: Record<string, unknown>[] = [];
        if (model.networkAddress.ipv6.address) {
            const { address, prefix } = parseIpv6Address(model.networkAddress.ipv6.address);
            ipv6AddressData = [
                {
                    address: { t: "s", v: address },
                    prefix: { t: "u", v: prefix },
                },
            ];
        }

        const dnsServers = [model.networkAddress.ipv6.primaryDns, model.networkAddress.ipv6.secondaryDns].filter(
            (dns) => dns && dns.trim()
        ) as string[];

        // NM expects IPv6 DNS as array of byte arrays (aay). Cockpit's D-Bus
        // bridge accepts base64-encoded strings for byte array values.
        const dnsBytes = dnsServers.map((ip) => {
            const bytes = ipv6ToBytes(ip);
            return btoa(String.fromCharCode(...bytes));
        });

        settings.ipv6 = {
            method: { t: "s", v: "manual" },
            "address-data": { t: "aa{sv}", v: ipv6AddressData },
            gateway: { t: "s", v: model.networkAddress.ipv6.gateway || "" },
            dns: { t: "aay", v: dnsBytes },
            "ignore-auto-dns": { t: "b", v: !model.networkAddress.ipv6.autoDns },
            "may-fail": { t: "b", v: model.networkAddress.ipv6.mayFail },
        };
    } else if (model.networkAddress.ipv6.method === "disabled") {
        settings.ipv6 = {
            method: { t: "s", v: "disabled" },
        };
    } else if (model.networkAddress.ipv6.method === "dhcp") {
        settings.ipv6 = {
            method: { t: "s", v: "dhcp" },
            "may-fail": { t: "b", v: model.networkAddress.ipv6.mayFail },
        };
    } else {
        settings.ipv6 = {
            method: { t: "s", v: "auto" },
            "may-fail": { t: "b", v: model.networkAddress.ipv6.mayFail },
        };
    }

    return settings;
}

export async function applyNetworkConfiguration(
    networkManager: NetworkManagerModel | undefined,
    model: Model,
    skipActivation = false
): Promise<NetworkApplyResult> {
    const actions: StepAction[] = [];

    if (!networkManager) {
        pushNetworkAction(actions, "NetworkManager unavailable", "error");
        return { actions };
    }

    if (!model.networkInterface.selectedInterface) {
        pushNetworkAction(actions, "No network interface selected", "error");
        return { actions };
    }

    const ifaceName = model.networkInterface.selectedInterface;
    const interfaces: Interface[] = networkManager.list_interfaces();

    try {
        const selectedIface = interfaces.find((iface: Interface) => iface.Name === ifaceName);

        if (!selectedIface) {
            throw new Error(`Interface ${ifaceName} not found`);
        }

        const interfaceType = model.networkInterface.interfaceType || "ethernet";
        const { isVlan, effectiveIfaceName } = resolveVlanInfo(
            ifaceName,
            interfaceType,
            model.networkInterface.vlanEnabled,
            model.networkInterface.vlanId
        );
        const connectionId = `${ONBOARDING_PROFILE_PREFIX}${effectiveIfaceName}`;

        // Delete any previously created onboarding profile for this interface
        try {
            await deleteOnboardingProfiles(ifaceName);
            if (isVlan) {
                await deleteOnboardingProfiles(effectiveIfaceName);
            }
        } catch (cleanupError) {
            console.warn("Failed to clean up previous onboarding profile:", cleanupError);
        }

        // Stop onboarding network services on this interface before applying
        // the production profile. Skip when skipActivation is true (single-NIC
        // path) — apply-and-enroll.sh handles teardown in that case.
        if (!skipActivation) {
            const dnsmasqUnit = `flightctl-onboarding-dnsmasq@${ifaceName}.service`;
            const wifiApUnit = `flightctl-onboarding-wifi-ap@${ifaceName}.service`;
            for (const unit of [dnsmasqUnit, wifiApUnit]) {
                try {
                    const isActive = await cockpit
                        .spawn(["systemctl", "is-active", "--quiet", unit], { err: "ignore" })
                        .then(
                            () => true,
                            () => false
                        );

                    if (isActive) {
                        await cockpit.spawn(["sudo", "systemctl", "stop", unit], { err: "message" });
                    }
                } catch (err) {
                    console.warn(`Failed to stop ${unit}:`, err);
                }
            }
        }

        // Build NM connection settings for the new profile
        const settings = buildConnectionSettings(model, ifaceName, interfaceType);

        // Create the new connection profile via NM D-Bus
        const nmClient = cockpit.dbus("org.freedesktop.NetworkManager", { superuser: "try" });
        try {
            console.log("Creating new NM connection profile:", connectionId);

            const settingsProxy = nmClient.proxy(
                "org.freedesktop.NetworkManager.Settings",
                "/org/freedesktop/NetworkManager/Settings"
            );
            await waitForProxy(settingsProxy);

            const newConnectionPath = await nmClient.call(
                "/org/freedesktop/NetworkManager/Settings",
                "org.freedesktop.NetworkManager.Settings",
                "AddConnection",
                [settings]
            );

            pushNetworkAction(actions, `Created new connection profile: ${connectionId}`);
            console.log("New connection path:", newConnectionPath);

            if (skipActivation) {
                pushNetworkAction(actions, `Created profile ${connectionId} (activation deferred to systemd-run)`);
            } else {
                let devicePath = "/";
                if (!isVlan) {
                    const devicePathResult = await nmClient.call(
                        "/org/freedesktop/NetworkManager",
                        "org.freedesktop.NetworkManager",
                        "GetDeviceByIpIface",
                        [ifaceName]
                    );
                    devicePath = dbusPathResult(devicePathResult);
                }

                console.log("Activating connection on device:", devicePath);

                const activeConnResult = await nmClient.call(
                    "/org/freedesktop/NetworkManager",
                    "org.freedesktop.NetworkManager",
                    "ActivateConnection",
                    [newConnectionPath[0] || newConnectionPath, devicePath, "/"]
                );

                const activeConnPath = dbusPathResult(activeConnResult);
                await waitForActivation(nmClient, activeConnPath);

                pushNetworkAction(actions, `Activated connection ${connectionId} on ${effectiveIfaceName}`);
            }
        } catch (networkError) {
            const errorMsg = String(networkError);
            console.error("NetworkManager configuration error:", networkError);

            if (
                errorMsg.includes("Interactive authentication required") ||
                errorMsg.includes("org.freedesktop.PolicyKit1.Error.Failed")
            ) {
                throw new Error(
                    "Network configuration requires administrator privileges. Please ensure you have sufficient permissions."
                );
            }

            throw new Error(`Failed to create/activate network profile: ${errorMsg}`);
        } finally {
            nmClient.close();
        }

        if (model.networkAddress.ipv4.method === "static") {
            const prefixLength = model.networkAddress.ipv4.subnetMask
                ? subnetMaskToPrefixLength(model.networkAddress.ipv4.subnetMask)
                : 24;
            pushNetworkAction(actions, `IPv4 configured: ${model.networkAddress.ipv4.address}/${prefixLength}`);
        } else if (model.networkAddress.ipv4.method === "disabled") {
            pushNetworkAction(actions, "IPv4 disabled");
        } else {
            pushNetworkAction(actions, "IPv4 configured for automatic (DHCP)");
        }

        if (model.networkAddress.ipv6.method === "static") {
            pushNetworkAction(actions, `IPv6 configured: ${model.networkAddress.ipv6.address}`);
        } else if (model.networkAddress.ipv6.method === "disabled") {
            pushNetworkAction(actions, "IPv6 disabled");
        } else if (model.networkAddress.ipv6.method === "dhcp") {
            pushNetworkAction(actions, "IPv6 configured for stateful DHCPv6");
        } else {
            pushNetworkAction(actions, "IPv6 configured for automatic (SLAAC)");
        }
    } catch (error) {
        throw new Error(`Network configuration failed: ${String(error)}`);
    }

    return { actions };
}

async function deleteOnboardingProfiles(ifaceName?: string): Promise<void> {
    const nmClient = cockpit.dbus("org.freedesktop.NetworkManager", { superuser: "try" });

    try {
        const settingsProxy = nmClient.proxy(
            "org.freedesktop.NetworkManager.Settings",
            "/org/freedesktop/NetworkManager/Settings"
        );
        await waitForProxy(settingsProxy);

        const connectionsResult = await nmClient.call(
            "/org/freedesktop/NetworkManager/Settings",
            "org.freedesktop.NetworkManager.Settings",
            "ListConnections",
            []
        );

        const connectionPaths = dbusPathListResult(connectionsResult);

        for (const connPath of connectionPaths) {
            try {
                const connSettings = await nmClient.call(
                    connPath,
                    "org.freedesktop.NetworkManager.Settings.Connection",
                    "GetSettings",
                    []
                );

                const connData = (connSettings[0] || connSettings) as NmConnectionSettings;
                const connectionId = connData.connection?.id;
                const connId =
                    typeof connectionId === "object" && connectionId !== null
                        ? connectionId.v || ""
                        : connectionId || "";

                const prefix = ifaceName ? `${ONBOARDING_PROFILE_PREFIX}${ifaceName}` : ONBOARDING_PROFILE_PREFIX;

                if (typeof connId === "string" && connId.startsWith(prefix)) {
                    console.log(`Deleting onboarding profile: ${connId} at ${connPath}`);
                    await nmClient.call(connPath, "org.freedesktop.NetworkManager.Settings.Connection", "Delete", []);
                }
            } catch (connError) {
                console.warn(`Failed to inspect/delete connection ${connPath}:`, connError);
            }
        }
    } finally {
        nmClient.close();
    }
}

