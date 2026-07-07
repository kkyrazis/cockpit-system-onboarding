import cockpit from "cockpit";
import { SCRIPT_FINALIZE } from "../paths";
import type { Model } from "../model-context";
import { buildFlightctlCredentialsJson, getFlightctlServiceDescriptor } from "../flightctl-enrollment";
import type { CancellationSignal } from "./connectivity";
import { disarmWatchdog } from "./watchdog";
import { deleteAttemptedMarker } from "../attempted-marker";
import { createSecureTempFile } from "./spawn-helpers";
import {
    createActionEmitter,
    ENROLLMENT_ACTION_IDS,
    makeStepAction,
    type OnStepAction,
    type StepExecutionResult,
} from "../wizard/enrollment-progress-types";

const EXIT_CODE_MESSAGES: Record<number, string> = {
    2: "The provided credentials were rejected by the server",
    3: "Cannot reach the enrollment server",
    4: "Network connectivity error — check your network configuration",
};

function getExitCodeMessage(exitCode: number, endpoint?: string): string | null {
    const template = EXIT_CODE_MESSAGES[exitCode];
    if (!template) {
        return null;
    }
    if (exitCode === 3 && endpoint) {
        return `${template} at ${endpoint}`;
    }
    return template;
}

export function buildEnrollmentParams(model: Model, brandName?: string): Record<string, unknown> {
    const enrollment = model.enrollment;
    const networkProxy = model.networkServices.proxy;
    const service = getFlightctlServiceDescriptor(brandName !== undefined ? { brandName } : null);

    return {
        ENROLLMENT_SERVICE_ID: service.id,
        ENROLLMENT_SERVICE_NAME: service.name,
        ENROLLMENT_ENDPOINT: enrollment.endpoint || "",
        ENROLLMENT_CREDENTIALS_JSON: buildFlightctlCredentialsJson(enrollment.credentials),
        ENROLLMENT_USE_EXISTING: Boolean(enrollment.useExisting),
        ENROLLMENT_HOSTNAME: model.hostname.value,
        ENROLLMENT_INTERFACE: model.networkInterface.selectedInterface || "",
        // TODO: Review backend wiring for proxy.applyForHttps (flightctl-enroll.sh).
        ENROLLMENT_PROXY_ENABLED: networkProxy.enabled,
        ENROLLMENT_PROXY_PROTOCOL: networkProxy.protocol || "http",
        ENROLLMENT_PROXY_HOSTNAME: networkProxy.hostname || "",
        ENROLLMENT_PROXY_PORT: networkProxy.port ?? "",
        ENROLLMENT_PROXY_USERNAME: networkProxy.username || "",
        ENROLLMENT_PROXY_PASSWORD: networkProxy.password || "",
        ENROLLMENT_PROXY_NO_PROXY: networkProxy.noProxy || "",
        ENROLLMENT_TLS_MODE: enrollment.tlsMode || "system",
        ENROLLMENT_CA_CERT_PEM: enrollment.caCertPem || "",
    };
}

export async function executeEnrollmentScript(
    scriptPath: string,
    params: Record<string, unknown>,
    signal?: CancellationSignal,
    onAction?: OnStepAction
): Promise<StepExecutionResult> {
    let capturedOutput = "";
    let paramsFile = "";
    const serviceId = String(params.ENROLLMENT_SERVICE_ID || "");
    const serviceName = String(params.ENROLLMENT_SERVICE_NAME || "");
    const endpoint = String(params.ENROLLMENT_ENDPOINT || "");
    const { emit, getActions } = createActionEmitter(onAction);

    try {
        console.log(`Executing enrollment script: ${scriptPath}`);
        console.log("Service:", serviceName, `(${serviceId})`);
        console.log("Endpoint:", endpoint);

        emit({
            id: ENROLLMENT_ACTION_IDS.ENROLLMENT_SCRIPT,
            actionTitle: `Executing enrollment script for ${serviceName}`,
            result: "pending",
        });

        paramsFile = await createSecureTempFile(JSON.stringify(params), `.enrollment-${serviceId}-`);

        const proc = cockpit.spawn(["sudo", scriptPath, paramsFile], {
            err: "out",
        });
        if (signal) {
            signal.process = proc;
        }

        let streamLineIndex = 0;
        proc.stream((data) => {
            capturedOutput += data;
            const line = data.trim();
            if (line) {
                emit({ id: `enrollment-stream-${streamLineIndex++}`, actionTitle: line, result: "pending" });
            }
        });

        await proc;
        if (signal) {
            signal.process = undefined;
        }
        console.log(`Script ${scriptPath} completed successfully`);

        emit({
            id: ENROLLMENT_ACTION_IDS.ENROLLMENT_SCRIPT,
            actionTitle: `Executing enrollment script for ${serviceName}`,
            result: "success",
        });

        const deviceUrlMatch = capturedOutput.match(/^DEVICE_URL:\s*(.+)$/m);
        if (deviceUrlMatch) {
            const url = deviceUrlMatch[1].trim();
            if (url.startsWith("http://") || url.startsWith("https://")) {
                console.log(`Parsed device URL: ${url}`);
                return {
                    success: true,
                    actions: getActions(),
                    deviceUrl: url,
                };
            }
        }

        return { success: true, actions: getActions() };
    } catch (error) {
        if (signal) {
            signal.process = undefined;
        }
        console.error(`Script ${scriptPath} failed:`, error);

        let errorMsg = "";
        let friendlyMsg = "";

        if (capturedOutput.trim()) {
            errorMsg = capturedOutput.trim();
        }

        if (error instanceof cockpit.ProcessError && error.exit_status !== null) {
            const exitCode = error.exit_status;
            friendlyMsg = getExitCodeMessage(exitCode, endpoint) || "";

            const statusMsg = `Script exited with status ${exitCode}`;
            errorMsg = errorMsg ? `${errorMsg}\n${statusMsg}` : statusMsg;
        }

        const fullMsg = friendlyMsg ? `${friendlyMsg}\n\n${errorMsg}` : errorMsg || "Script failed with unknown error";

        emit({ id: ENROLLMENT_ACTION_IDS.ENROLLMENT_SCRIPT, actionTitle: fullMsg, result: "error" });
        return { success: false, actions: getActions() };
    } finally {
        if (paramsFile) {
            cockpit.spawn(["rm", "-f", paramsFile], { err: "message" }).catch(() => {});
        }
    }
}

export async function finalizeEnrollment(hostname: string, onAction?: OnStepAction): Promise<StepExecutionResult> {
    const markerTitle = "Onboarding completion marker created";
    const { emit, getActions } = createActionEmitter(onAction);
    emit({ id: ENROLLMENT_ACTION_IDS.FINALIZE_MARKER, actionTitle: markerTitle, result: "pending" });

    try {
        await cockpit.spawn(["sudo", SCRIPT_FINALIZE, hostname], { err: "message" });
        emit(makeStepAction(ENROLLMENT_ACTION_IDS.FINALIZE_MARKER, markerTitle, "success"));
        await disarmWatchdog();
        await deleteAttemptedMarker();
        return { success: true, actions: getActions() };
    } catch (error) {
        console.error("Failed to finalize onboarding:", error);
        const errorTitle = `Failed to create completion marker: ${String(error)}`;
        emit(makeStepAction(ENROLLMENT_ACTION_IDS.FINALIZE_MARKER, errorTitle, "error"));
        return { success: false, actions: getActions() };
    }
}
