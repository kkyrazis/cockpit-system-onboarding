import cockpit from "cockpit";

import {
    createActionEmitter,
    ENROLLMENT_ACTION_IDS,
    type OnStepAction,
    type StepExecutionResult,
} from "../wizard/enrollment-progress-types";
import type { TlsMode } from "../types";
import { createSecureTempFile } from "./spawn-helpers";

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function isIPAddress(host: string): boolean {
    return IPV4_RE.test(host) || IPV6_RE.test(host);
}

export interface CancellationSignal {
    cancelled: boolean;
    process?: cockpit.Spawn<string> | undefined;
}

export async function testNetworkConnectivity(
    testHost: string,
    iface: string | undefined,
    signal?: CancellationSignal,
    onAction?: OnStepAction
): Promise<StepExecutionResult> {
    const { emit, getActions } = createActionEmitter(onAction);

    try {
        if (isIPAddress(testHost)) {
            emit({
                id: "dns-skip-ip",
                actionTitle: "Host is an IP address, skipping DNS resolution.",
                result: "success",
            });
        } else {
            try {
                const dnsLabel = iface ? `${testHost} via ${iface}` : testHost;
                const resolveTitle = `Resolving ${dnsLabel} via DNS`;
                emit({ id: ENROLLMENT_ACTION_IDS.DNS_RESOLVE, actionTitle: resolveTitle, result: "pending" });
                const dnsArgs = iface
                    ? ["resolvectl", "query", `--interface=${iface}`, testHost]
                    : ["getent", "hosts", testHost];
                const dnsProc = cockpit.spawn(dnsArgs, { err: "ignore" });
                if (signal) {
                    signal.process = dnsProc;
                }
                await dnsProc;
                if (signal) {
                    signal.process = undefined;
                }
                emit({ id: ENROLLMENT_ACTION_IDS.DNS_RESOLVE, actionTitle: resolveTitle, result: "success" });
            } catch (dnsError) {
                if (signal) {
                    signal.process = undefined;
                }

                let errorDetail = "";
                if (dnsError instanceof cockpit.ProcessError && dnsError.exit_status !== null) {
                    errorDetail = ` (exit status ${dnsError.exit_status})`;
                }

                const errorTitle = `DNS resolution failed${errorDetail}. Please check network configuration.`;
                emit({ id: ENROLLMENT_ACTION_IDS.DNS_RESOLVE, actionTitle: errorTitle, result: "error" });
                return { success: false, actions: getActions() };
            }
        }

        try {
            const pingLabel = iface ? `${testHost} via ${iface}` : testHost;
            const pingTitle = `Pinging ${pingLabel}`;
            emit({ id: ENROLLMENT_ACTION_IDS.PING, actionTitle: pingTitle, result: "pending" });
            const pingArgs = ["timeout", "10", "ping", "-c", "1", "-W", "5"];
            if (iface) {
                pingArgs.push("-I", iface);
            }
            pingArgs.push(testHost);
            const pingProc = cockpit.spawn(pingArgs, { err: "ignore" });
            if (signal) {
                signal.process = pingProc;
            }
            await pingProc;
            if (signal) {
                signal.process = undefined;
            }
            emit({ id: ENROLLMENT_ACTION_IDS.PING, actionTitle: pingTitle, result: "success" });
            return { success: true, actions: getActions() };
        } catch (pingError) {
            if (signal) {
                signal.process = undefined;
            }
            console.warn(`Ping failed for ${testHost}:`, pingError);
            const warningTitle = "Ping failed. However, pings may be simply blocked by firewall.";
            emit({ id: ENROLLMENT_ACTION_IDS.PING, actionTitle: warningTitle, result: "warning" });
            return { success: true, actions: getActions() };
        }
    } catch (error) {
        if (signal) {
            signal.process = undefined;
        }
        console.error("Connectivity test error:", error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        const fullErrorMsg = `Network connectivity test failed: ${errorMsg}`;
        emit({ id: "connectivity-error", actionTitle: fullErrorMsg, result: "error" });
        return { success: false, actions: getActions() };
    }
}

export async function verifyServiceConnectivity(
    endpoint: string,
    useExisting: boolean,
    signal?: CancellationSignal,
    onAction?: OnStepAction,
    tlsMode?: TlsMode,
    caCertPem?: string
): Promise<StepExecutionResult> {
    const { emit, getActions } = createActionEmitter(onAction);

    const credentialTitle = useExisting
        ? "The connectivity to the server in the existing enrollment credentials will be verified next."
        : "The connectivity to the server in the new enrollment credentials will be verified next.";
    emit({ id: ENROLLMENT_ACTION_IDS.CREDENTIAL_SELECTION, actionTitle: credentialTitle, result: "info" });

    if (!endpoint) {
        const msg = "No endpoint configured — cannot verify connectivity.";
        emit({ id: "verify-endpoint-missing", actionTitle: msg, result: "error" });
        return { success: false, actions: getActions() };
    }

    let hostname: string;
    try {
        hostname = new URL(endpoint).hostname;
    } catch {
        const msg = `Invalid endpoint URL: ${endpoint}`;
        emit({ id: "verify-endpoint-invalid", actionTitle: msg, result: "error" });
        return { success: false, actions: getActions() };
    }

    if (isIPAddress(hostname)) {
        emit({
            id: "dns-skip-ip",
            actionTitle: "Host is an IP address, skipping DNS resolution.",
            result: "success",
        });
    } else {
        try {
            const resolveTitle = `Resolving ${hostname}`;
            emit({ id: ENROLLMENT_ACTION_IDS.DNS_RESOLVE, actionTitle: resolveTitle, result: "pending" });
            const dnsProc = cockpit.spawn(["getent", "hosts", hostname], { err: "ignore" });
            if (signal) {
                signal.process = dnsProc;
            }
            await dnsProc;
            if (signal) {
                signal.process = undefined;
            }
            emit({ id: ENROLLMENT_ACTION_IDS.DNS_RESOLVE, actionTitle: resolveTitle, result: "success" });
        } catch {
            if (signal) {
                signal.process = undefined;
            }
            const msg = `Cannot resolve ${hostname}. Check DNS configuration.`;
            emit({ id: ENROLLMENT_ACTION_IDS.DNS_RESOLVE, actionTitle: msg, result: "error" });
            return { success: false, actions: getActions() };
        }
    }

    let caCertFile = "";
    try {
        const curlArgs = ["curl", "-sf", "--max-time", "10"];
        const effectiveTlsMode = tlsMode ?? "system";
        if (effectiveTlsMode === "insecure") {
            curlArgs.push("-k");
        } else if (effectiveTlsMode === "customCa" && caCertPem) {
            caCertFile = await createSecureTempFile(caCertPem, ".ca-cert-");
            curlArgs.push("--cacert", caCertFile);
        }
        curlArgs.push("-o", "/dev/null", "-w", "%{http_code}", `${endpoint}/api/v1/version`);

        const connectTitle = `Connecting to ${endpoint}`;
        emit({ id: ENROLLMENT_ACTION_IDS.CONNECT_ENDPOINT, actionTitle: connectTitle, result: "pending" });
        const curlProc = cockpit.spawn(curlArgs, { err: "ignore" });
        if (signal) {
            signal.process = curlProc;
        }
        await curlProc;
        if (signal) {
            signal.process = undefined;
        }

        emit({ id: ENROLLMENT_ACTION_IDS.CONNECT_ENDPOINT, actionTitle: connectTitle, result: "success" });
        return { success: true, actions: getActions() };
    } catch {
        if (signal) {
            signal.process = undefined;
        }
        const msg = `Cannot connect to ${endpoint}. The server may be unreachable.`;
        emit({ id: ENROLLMENT_ACTION_IDS.CONNECT_ENDPOINT, actionTitle: msg, result: "error" });
        return { success: false, actions: getActions() };
    } finally {
        if (caCertFile) {
            cockpit.spawn(["rm", "-f", caCertFile], { err: "message" }).catch(() => {});
        }
    }
}
