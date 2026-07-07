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
    type StepAction,
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

    let streamLineIndex = 0;
    let streamBuffer = "";
    let currentStepAction: StepAction | undefined;

    const processLine = (line: string) => {
        if (line.startsWith("STEP:")) {
            currentStepAction = {
                id: `enrollment-stream-${streamLineIndex++}`,
                actionTitle: line.slice(5).trim(),
                result: "pending",
            };
            emit(currentStepAction);
        } else if (line.startsWith("OK:")) {
            const title = line.slice(3).trim();
            if (currentStepAction) {
                emit({ ...currentStepAction, actionTitle: title, result: "success" });
                currentStepAction = undefined;
            } else {
                emit({ id: `enrollment-stream-${streamLineIndex++}`, actionTitle: title, result: "success" });
            }
        } else if (line.startsWith("ERROR:")) {
            const title = line.slice(6).trim();
            if (currentStepAction) {
                emit({ ...currentStepAction, actionTitle: title, result: "error" });
                currentStepAction = undefined;
            } else {
                emit({ id: `enrollment-stream-${streamLineIndex++}`, actionTitle: title, result: "error" });
            }
        } else if (line.startsWith("INFO:")) {
            emit({ id: `enrollment-stream-${streamLineIndex++}`, actionTitle: line.slice(5).trim(), result: "info" });
        }
    };

    const flushStreamBuffer = () => {
        const trailing = streamBuffer.trim();
        if (trailing) processLine(trailing);
        streamBuffer = "";
    };

    try {
        paramsFile = await createSecureTempFile(JSON.stringify(params), `.enrollment-${serviceId}-`);

        const proc = cockpit.spawn(["sudo", scriptPath, paramsFile], {
            err: "out",
        });
        if (signal) {
            signal.process = proc;
        }

        proc.stream((data) => {
            capturedOutput += data;
            streamBuffer += data;
            const parts = streamBuffer.split("\n");
            streamBuffer = parts.pop() ?? "";
            for (const part of parts) {
                const line = part.trim();
                if (line) processLine(line);
            }
        });

        await proc;
        if (signal) {
            signal.process = undefined;
        }
        flushStreamBuffer();

        const deviceUrlMatch = capturedOutput.match(/^DEVICE_URL:\s*(.+)$/m);
        if (deviceUrlMatch) {
            const url = deviceUrlMatch[1].trim();
            if (url.startsWith("http://") || url.startsWith("https://")) {
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
        flushStreamBuffer();

        if (currentStepAction) {
            emit({ ...currentStepAction, result: "error" });
            currentStepAction = undefined;
        }

        const hasErrorAction = getActions().some((a) => a.result === "error");
        if (!hasErrorAction) {
            let friendlyMsg = "";
            if (error instanceof cockpit.ProcessError && error.exit_status !== null) {
                friendlyMsg = getExitCodeMessage(error.exit_status, endpoint) || "";
            }
            emit({
                id: `enrollment-stream-${streamLineIndex++}`,
                actionTitle: friendlyMsg || "Enrollment script failed",
                result: "error",
            });
        }
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
