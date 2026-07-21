import cockpit from "cockpit";
import { Model } from "./model-context";
import { serializeEnrollmentForMarker } from "./enrollment-state";
import type { PersistedEnrollmentState } from "./enrollment-state";
import { MARKER_ATTEMPTED } from "./paths";
import { ProxyProtocol, WifiBand, WifiSecurity } from "./types";

export interface AttemptedMarkerData {
    attemptedAt: string;
    hostname: {
        value: string;
        dhcpHostname?: string;
    };
    networkInterface: {
        selectedInterface: string | null;
        interfaceType: "ethernet" | "wifi" | null;
        wifiSsid: string | null;
        wifiSecurity: WifiSecurity | null;
        wifiBand: WifiBand | null;
        vlanEnabled?: boolean;
        vlanId: number | null;
    };
    networkAddress: Model["networkAddress"];
    userNetworkConfigs: Model["userNetworkConfigs"];
    networkServices: {
        ntp: Model["networkServices"]["ntp"];
        proxy: {
            enabled: boolean;
            protocol: ProxyProtocol;
            hostname: string | null;
            port: number | null;
            noProxy: string;
        };
    };
    enrollment: PersistedEnrollmentState;
    alias: Model["alias"];
    labels: Model["labels"];
    connectivityTestHost: string;
    connectivityTestRequired?: boolean;
}

function serializeModel(model: Model): AttemptedMarkerData {
    return {
        attemptedAt: new Date().toISOString(),
        hostname: {
            value: model.hostname.value,
            ...(model.hostname.dhcpHostname !== undefined && { dhcpHostname: model.hostname.dhcpHostname }),
        },
        networkInterface: {
            selectedInterface: model.networkInterface.selectedInterface,
            interfaceType: model.networkInterface.interfaceType,
            wifiSsid: model.networkInterface.wifiSsid,
            wifiSecurity: model.networkInterface.wifiSecurity,
            wifiBand: model.networkInterface.wifiBand,
            vlanEnabled: model.networkInterface.vlanEnabled,
            vlanId: model.networkInterface.vlanId,
        },
        networkAddress: { ...model.networkAddress },
        userNetworkConfigs: { ...model.userNetworkConfigs },
        networkServices: {
            ntp: { ...model.networkServices.ntp },
            proxy: {
                enabled: model.networkServices.proxy.enabled,
                protocol: model.networkServices.proxy.protocol,
                hostname: model.networkServices.proxy.hostname,
                port: model.networkServices.proxy.port,
                noProxy: model.networkServices.proxy.noProxy || "localhost,127.0.0.1,::1",
            },
        },
        enrollment: serializeEnrollmentForMarker(model.enrollment),
        alias: { ...model.alias },
        labels: {
            deviceLabels: [...model.labels.deviceLabels],
            systemInfoMappings: [...model.labels.systemInfoMappings],
        },
        connectivityTestHost: model.connectivityTestHost,
        connectivityTestRequired: model.connectivityTestRequired,
    };
}

export async function writeAttemptedMarker(model: Model): Promise<void> {
    try {
        const data = serializeModel(model);
        const content = JSON.stringify(data, null, 2);
        await cockpit.file(MARKER_ATTEMPTED, { superuser: "try" }).replace(content);
    } catch (error) {
        console.warn("Failed to write attempted marker:", error);
    }
}

export async function readAttemptedMarker(): Promise<AttemptedMarkerData | null> {
    try {
        const file = cockpit.file(MARKER_ATTEMPTED, { superuser: "try" });
        const content = await file.read();
        file.close();

        if (content === null) {
            return null;
        }

        const data = JSON.parse(content) as AttemptedMarkerData;

        if (!data.hostname || !data.networkAddress) {
            console.warn("Attempted marker file has unexpected structure, ignoring");
            return null;
        }

        return data;
    } catch (error) {
        console.warn("Failed to read attempted marker file:", error);
        return null;
    }
}

export async function deleteAttemptedMarker(): Promise<void> {
    try {
        await cockpit.spawn(["rm", "-f", MARKER_ATTEMPTED], { superuser: "try", err: "message" });
    } catch (error) {
        console.warn("Failed to delete attempted marker file:", error);
    }
}
