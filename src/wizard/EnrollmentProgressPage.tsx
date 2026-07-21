import React, { useEffect, useState } from "react";
import cockpit from "cockpit";

import { Progress } from "@patternfly/react-core/dist/esm/components/Progress/index.js";
import { Stack, StackItem } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { List, ListItem } from "@patternfly/react-core/dist/esm/components/List/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import {
    ExpandableSection,
    ExpandableSectionToggle,
} from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Card, CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Icon } from "@patternfly/react-core/dist/esm/components/Icon/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import {
    CheckCircleIcon,
    ExclamationCircleIcon,
    ExclamationTriangleIcon,
    InfoIcon,
    OutlinedClockIcon,
    PendingIcon,
} from "@patternfly/react-icons";

import { useModelContext } from "../model-context";
import { useConfig } from "../app";
import { systemConfigurationService } from "../system-config";
import { getHostnameInfo } from "../services/hostname";
import { isConnectedViaInterface, applyNetworkConfiguration } from "../services/network";
import { executeRollbackScript, type RollbackManifest } from "../services/rollback";
import { writeAttemptedMarker } from "../attempted-marker";
import { SCRIPT_RUN_APPLY_ENROLL, MARKER_COMPLETE } from "../paths";
import { SubtleHeading } from "../components/Headings.js";
import { armWatchdog, disarmWatchdog, readWatchdogStatus } from "../services/watchdog";
import { testNetworkConnectivity, CancellationSignal } from "../services/connectivity";
import { buildEnrollmentParams, executeEnrollmentScript, finalizeEnrollment } from "../services/enrollment";
import { createSecureTempFile } from "../services/spawn-helpers";
import { FLIGHTCTL_SCRIPT_PATH, FLIGHTCTL_SERVICE_ID, getBrandName } from "../flightctl-enrollment";
import {
    ENROLLMENT_ACTION_IDS,
    ENROLLMENT_STEP_PAUSE_MS,
    createActionEmitter,
    makeStepAction,
    sleep,
    upsertStepAction,
    type ActionResult,
    type EnrollmentProgressResultItem,
    type OnStepAction,
    type StepAction,
    type StepExecutionResult,
    type StepStatus,
} from "./enrollment-progress-types";

interface Step {
    id: string;
    name: string;
    status: StepStatus;
    deviceUrl?: string;
    isBuiltIn: boolean;
}

const _ = cockpit.gettext;

const getActionResultIcon = (result: ActionResult) => {
    switch (result) {
        case "pending":
            return <Spinner size="sm" aria-label={_("In progress")} />;
        case "info":
            return (
                <Icon status="info" iconSize="sm">
                    <InfoIcon />
                </Icon>
            );
        case "success":
            return (
                <Icon status="success" iconSize="sm">
                    <CheckCircleIcon />
                </Icon>
            );
        case "warning":
            return (
                <Icon status="warning" iconSize="sm">
                    <ExclamationTriangleIcon />
                </Icon>
            );
        case "error":
            return (
                <Icon status="danger" iconSize="sm">
                    <ExclamationCircleIcon />
                </Icon>
            );
    }
};

const StepActionRow: React.FunctionComponent<{ action: StepAction }> = ({ action }) => (
    <Flex direction={{ default: "column" }} gap={{ default: "gapNone" }}>
        <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
            <FlexItem>{action.actionTitle}</FlexItem>
            <FlexItem>{getActionResultIcon(action.result)}</FlexItem>
        </Flex>
        {action.detail && (
            <FlexItem>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "var(--pf-t--global--font--size--xs)" }}>
                    {action.detail}
                </pre>
            </FlexItem>
        )}
    </Flex>
);

const getNextEnrollmentStepId = (steps: Step[], afterStepId: string | null): string | null => {
    const startIndex = afterStepId ? steps.findIndex((step) => step.id === afterStepId) + 1 : 0;
    const nextStep = steps.slice(Math.max(0, startIndex)).find((step) => step.status !== "success");
    return nextStep?.id ?? null;
};

const findEnrollmentStep = (steps: Step[]): Step | undefined =>
    steps.find((step) => step.id.startsWith("enroll-")) ??
    steps.find((step) => step.id === `enroll-${FLIGHTCTL_SERVICE_ID}`);

const findOrphanActionStep = (steps: Step[]): Step | undefined =>
    steps.find((step) => step.status === "failed") ??
    findEnrollmentStep(steps) ??
    steps.find((step) => step.status === "delegated");

const isBackgroundEnrollmentFailure = (item: EnrollmentProgressResultItem): boolean =>
    item.type === "action" && item.action.id.startsWith("background-enrollment-failure-");

const groupResultsByStep = (
    steps: Step[],
    results: EnrollmentProgressResultItem[]
): Record<string, EnrollmentProgressResultItem[]> => {
    const groups = Object.fromEntries(steps.map((step) => [step.id, [] as EnrollmentProgressResultItem[]]));
    const stepNameToId = new Map(steps.map((step) => [step.name, step.id]));
    let currentStepId: string | null = null;

    for (const item of results) {
        if (item.type === "header") {
            const stepId = stepNameToId.get(item.content);
            if (stepId) {
                currentStepId = stepId;
                continue;
            }

            currentStepId = getNextEnrollmentStepId(steps, currentStepId);
            continue;
        }

        if (isBackgroundEnrollmentFailure(item)) {
            const enrollStep = findEnrollmentStep(steps);
            if (enrollStep) {
                groups[enrollStep.id].push(item);
                continue;
            }
        }

        if (currentStepId) {
            groups[currentStepId].push(item);
            continue;
        }

        if (item.type === "action") {
            const targetStep = findOrphanActionStep(steps);
            if (targetStep) {
                groups[targetStep.id].push(item);
            }
        }
    }

    return groups;
};

const getActiveStepId = (steps: Step[], executionState: string): string | null => {
    const runningStep = steps.find((step) => step.status === "running");
    if (runningStep) {
        return runningStep.id;
    }

    if (executionState === "failed") {
        return steps.find((step) => step.status === "failed")?.id ?? null;
    }

    if (executionState === "idle") {
        return steps.find((step) => step.status === "pending")?.id ?? null;
    }

    return null;
};

const getStepStatusLabel = (status: StepStatus): string | null => {
    switch (status) {
        case "running":
            return _("Running...");
        case "delegated":
            return _("Delegated to background service");
        default:
            return null;
    }
};

export const EnrollmentProgressPage: React.FunctionComponent<{ isApplyAuthorized?: boolean }> = ({
    isApplyAuthorized = false,
}) => {
    const { config } = useConfig();
    const brandName = getBrandName(config);
    const { model, updateModel, networkManager, cancelEnrollmentRef } = useModelContext();
    const [hasStarted, setHasStarted] = useState(false);
    const [isEnrollmentSelected, setIsEnrollmentSelected] = useState(false);
    const [steps, setSteps] = useState<Step[]>([]);
    const [results, setResults] = useState<EnrollmentProgressResultItem[]>([]);
    const [singleNic, setSingleNic] = useState(false);
    const [delegatedFailureMessage, setDelegatedFailureMessage] = useState<string | null>(null);
    const [expandedStepIds, setExpandedStepIds] = useState<string[]>([]);
    const networkAppliedRef = React.useRef(false);
    const rollbackManifestRef = React.useRef<RollbackManifest>({});
    const shouldCancelRef = React.useRef(false);
    const signalRef = React.useRef<CancellationSignal>({ cancelled: false });
    const delegatedFailureHandledRef = React.useRef(false);

    const getStepStatusIcon = (status: StepStatus) => {
        switch (status) {
            case "running":
                return <Spinner size="md" aria-label={_("In progress")} />;
            case "success":
                return (
                    <Icon status="success" iconSize="md">
                        <CheckCircleIcon />
                    </Icon>
                );
            case "failed":
                return (
                    <Icon status="danger" iconSize="md">
                        <ExclamationCircleIcon />
                    </Icon>
                );
            case "warning":
                return (
                    <Icon status="warning" iconSize="md">
                        <ExclamationTriangleIcon />
                    </Icon>
                );
            case "delegated":
                return (
                    <Icon status="info" iconSize="md">
                        <OutlinedClockIcon />
                    </Icon>
                );
            case "pending":
            default:
                return (
                    <Icon status="info" iconSize="md">
                        <PendingIcon />
                    </Icon>
                );
        }
    };

    const getStepStatusAriaLabel = (status: StepStatus, stepName: string): string => {
        switch (status) {
            case "pending":
                return cockpit.format(_("Not started: $0"), stepName);
            case "running":
                return cockpit.format(_("In progress: $0"), stepName);
            case "success":
                return cockpit.format(_("Completed: $0"), stepName);
            case "failed":
                return cockpit.format(_("Failed: $0"), stepName);
            case "warning":
                return cockpit.format(_("Warning: $0"), stepName);
            case "delegated":
                return cockpit.format(_("Delegated: $0"), stepName);
            default:
                return stepName;
        }
    };

    // Initialize steps based on enrollment configuration
    const initializeSteps = async () => {
        try {
            const enrollment = model.enrollment;
            const shouldEnroll = enrollment.selected;
            setIsEnrollmentSelected(shouldEnroll);

            const initialSteps: Step[] = [
                {
                    id: "apply-config",
                    name: _("Applying configuration changes"),
                    status: "pending",
                    isBuiltIn: true,
                },
                {
                    id: "test-connectivity",
                    name: cockpit.format(_("Testing network connectivity to $0"), model.connectivityTestHost),
                    status: "pending",
                    isBuiltIn: true,
                },
            ];

            if (shouldEnroll) {
                initialSteps.push({
                    id: `enroll-${FLIGHTCTL_SERVICE_ID}`,
                    name: enrollment.useExisting
                        ? cockpit.format(_("$0 enrollment"), brandName)
                        : cockpit.format(_("Enrolling into $0"), brandName),
                    status: "pending",
                    isBuiltIn: false,
                });
            }

            initialSteps.push({
                id: "finalize",
                name: shouldEnroll ? _("Finalizing enrollment") : _("Finalizing configuration"),
                status: "pending",
                isBuiltIn: true,
            });

            setSteps(initialSteps);
        } catch (error) {
            console.error("Failed to initialize enrollment steps:", error);
            // Fallback to basic steps if initialization fails
            setSteps([
                {
                    id: "apply-config",
                    name: _("Applying configuration changes"),
                    status: "pending",
                    isBuiltIn: true,
                },
                {
                    id: "test-connectivity",
                    name: cockpit.format(_("Testing network connectivity to $0"), model.connectivityTestHost),
                    status: "pending",
                    isBuiltIn: true,
                },
                {
                    id: "finalize",
                    name: _("Finalizing configuration"),
                    status: "pending",
                    isBuiltIn: true,
                },
            ]);
        }
    };

    // Execute a single step
    const executeStep = async (stepId: string, onAction?: OnStepAction): Promise<StepExecutionResult> => {
        const step = steps.find((s) => s.id === stepId);
        if (!step) {
            return {
                success: false,
                actions: [makeStepAction("step-not-found", "Step not found", "error")],
            };
        }

        setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, status: "running" } : s)));

        try {
            switch (stepId) {
                case "apply-config":
                    return await applyConfiguration(onAction);
                case "test-connectivity":
                    return await testConnectivity(onAction);
                case "finalize":
                    return await finalizeEnrollment(model.hostname.value, onAction);
                default:
                    if (stepId === `enroll-${FLIGHTCTL_SERVICE_ID}`) {
                        const enrollment = model.enrollment;

                        if (enrollment.useExisting) {
                            const { emit, getActions } = createActionEmitter(onAction);
                            emit({
                                id: "use-existing-creds",
                                actionTitle: _("Using existing enrollment certificate"),
                                result: "success",
                            });
                            return { success: true, actions: getActions() };
                        }

                        const params = buildEnrollmentParams(model, brandName);
                        return await executeEnrollmentScript(
                            FLIGHTCTL_SCRIPT_PATH,
                            params,
                            signalRef.current,
                            onAction
                        );
                    }
                    return {
                        success: false,
                        actions: [makeStepAction("unknown-step", "Unknown step", "error")],
                    };
            }
        } catch (error) {
            return {
                success: false,
                actions: [makeStepAction("step-error", String(error), "error")],
            };
        }
    };

    const applyConfiguration = async (onAction?: OnStepAction): Promise<StepExecutionResult> => {
        const applyTitle = _("Applying configuration updates");
        const { emit, getActions } = createActionEmitter(onAction);
        emit({ id: ENROLLMENT_ACTION_IDS.APPLY_CONFIGURATION, actionTitle: applyTitle, result: "pending" });

        try {
            const result = await systemConfigurationService.applySystemConfiguration(networkManager, model);

            networkAppliedRef.current = true;

            const manifest: RollbackManifest = {};
            if (result.appliedItems.hostname && result.originalHostname) {
                manifest.hostname = { original: result.originalHostname };
            }
            if (result.appliedItems.network) {
                const ifaceName = model.networkInterface.selectedInterface || "";
                const vlanId = model.networkInterface.vlanId;
                const isVlan = model.networkInterface.vlanEnabled && vlanId !== null && model.networkInterface.interfaceType !== "wifi";
                const effectiveIfaceName = isVlan ? `${ifaceName}.${vlanId}` : ifaceName;
                manifest.network = { connectionId: `flightctl-onboarding-${effectiveIfaceName}` };
            }
            if (result.appliedItems.ntp) {
                manifest.ntp = true;
            }
            if (result.appliedItems.proxy) {
                manifest.proxy = true;
            }
            if (result.appliedItems.labels) {
                manifest.labels = true;
            }
            rollbackManifestRef.current = manifest;

            emit({
                id: ENROLLMENT_ACTION_IDS.APPLY_CONFIGURATION,
                actionTitle: applyTitle,
                result: result.success ? "success" : "error",
            });
            result.actions.forEach((action) => emit(action));

            return {
                success: result.success,
                actions: getActions(),
            };
        } catch (error) {
            const errorMsg = String(error);
            emit({ id: "apply-configuration-error", actionTitle: errorMsg, result: "error" });
            return {
                success: false,
                actions: getActions(),
            };
        }
    };

    const testConnectivity = async (onAction?: OnStepAction): Promise<StepExecutionResult> => {
        const testHost = model.connectivityTestHost;
        const parentIface = model.networkInterface.selectedInterface || "";
        const vlanId = model.networkInterface.vlanId;
        const iface =
            model.networkInterface.vlanEnabled &&
            vlanId !== null &&
            parentIface &&
            model.networkInterface.interfaceType !== "wifi"
                ? `${parentIface}.${vlanId}`
                : parentIface;
        return testNetworkConnectivity(testHost, iface, signalRef.current, onAction);
    };

    // Detect whether the user is configuring the same NIC that serves this
    // browser session (single-NIC scenario).
    const detectSingleNic = async (): Promise<boolean> => {
        if (!model.networkInterface.selectedInterface) {
            return false;
        }
        return isConnectedViaInterface(model.networkInterface.selectedInterface);
    };

    // Single-NIC delegation: apply hostname/NTP in-process, create the NM
    // profile without activating, write params files, and hand off network
    // activation + enrollment to a systemd-run transient unit that survives
    // cockpit-bridge exit.
    const executeSingleNicDelegation = async (resultsBuffer: EnrollmentProgressResultItem[]) => {
        const onAction: OnStepAction = (action) => {
            upsertStepAction(resultsBuffer, action);
            setResults([...resultsBuffer]);
        };

        // -- apply-config step: hostname + NTP only (skip network) --
        setSteps((prev) => prev.map((s) => (s.id === "apply-config" ? { ...s, status: "running" } : s)));
        resultsBuffer.push({ type: "header", content: _("Applying configuration changes") });
        setResults([...resultsBuffer]);

        const originalHostname = await getHostnameInfo()
            .then((info) => info.staticHostname || info.hostname)
            .catch(() => "");

        try {
            onAction({
                id: ENROLLMENT_ACTION_IDS.APPLY_HOSTNAME_NTP,
                actionTitle: _("Applying hostname and NTP configuration"),
                result: "pending",
            });
            const configResult = await systemConfigurationService.applySystemConfiguration(networkManager, model, {
                skipNetwork: true,
            });
            if (configResult.success) {
                onAction({
                    id: ENROLLMENT_ACTION_IDS.APPLY_HOSTNAME_NTP,
                    actionTitle: _("Applying hostname and NTP configuration"),
                    result: "success",
                });
            } else {
                onAction({
                    id: ENROLLMENT_ACTION_IDS.APPLY_HOSTNAME_NTP,
                    actionTitle: _("Failed to apply hostname/NTP configuration"),
                    result: "error",
                });
                setSteps((prev) => prev.map((s) => (s.id === "apply-config" ? { ...s, status: "failed" } : s)));
                await disarmWatchdog();
                updateModel("enrollmentProgress", { executionState: "failed" });
                return;
            }

            configResult.actions.forEach((action) => onAction(action));

            const deferredTitle = _("Creating network profile (activation deferred)");
            onAction({
                id: ENROLLMENT_ACTION_IDS.CREATE_NETWORK_PROFILE,
                actionTitle: deferredTitle,
                result: "pending",
            });
            await applyNetworkConfiguration(networkManager, model, true);
            onAction({
                id: ENROLLMENT_ACTION_IDS.CREATE_NETWORK_PROFILE,
                actionTitle: deferredTitle,
                result: "success",
            });
            onAction({
                id: ENROLLMENT_ACTION_IDS.NETWORK_PROFILE_CREATED,
                actionTitle: _("Network profile created successfully."),
                result: "success",
            });

            setSteps((prev) => prev.map((s) => (s.id === "apply-config" ? { ...s, status: "success" } : s)));
        } catch (error) {
            onAction({ id: "single-nic-delegation-error", actionTitle: `Failed: ${String(error)}`, result: "error" });
            setSteps((prev) => prev.map((s) => (s.id === "apply-config" ? { ...s, status: "failed" } : s)));
            await disarmWatchdog();
            updateModel("enrollmentProgress", { executionState: "failed" });
            return;
        }

        // -- Write enrollment params files for each service (skip services that evaluated to "skip") --
        const enrollmentScriptEntries: { scriptPath: string; paramsFile: string }[] = [];
        const tempFilesToCleanup: string[] = [];
        if (isEnrollmentSelected) {
            const enrollment = model.enrollment;
            if (!enrollment.useExisting) {
                const params = buildEnrollmentParams(model, brandName);
                const pf = await createSecureTempFile(JSON.stringify(params), `.enrollment-${FLIGHTCTL_SERVICE_ID}-`);
                tempFilesToCleanup.push(pf);
                enrollmentScriptEntries.push({ scriptPath: FLIGHTCTL_SCRIPT_PATH, paramsFile: pf });
            }
        }

        // -- Write master params JSON for apply-and-enroll.sh --
        const ifaceName = model.networkInterface.selectedInterface || "";
        const vlanId = model.networkInterface.vlanId;
        const isVlan =
            model.networkInterface.vlanEnabled && vlanId !== null && model.networkInterface.interfaceType !== "wifi";
        const effectiveIfaceName = isVlan ? `${ifaceName}.${vlanId}` : ifaceName;
        const masterParams = {
            connectionId: `flightctl-onboarding-${effectiveIfaceName}`,
            interfaceName: ifaceName,
            effectiveIfaceName,
            enrollmentScripts: enrollmentScriptEntries,
            hostname: model.hostname.value,
            originalHostname,
            connectivityTestHost: model.connectivityTestHost,
            carrierTimeoutSeconds: config?.connectivityTest?.carrierTimeoutSeconds ?? 300,
            connectivityRetries: config?.connectivityTest?.connectivityRetries ?? 30,
            connectivityTestRequired: model.connectivityTestRequired,
        };
        const masterParamsFile = await createSecureTempFile(JSON.stringify(masterParams), ".onboarding-apply-");
        tempFilesToCleanup.push(masterParamsFile);

        // -- Mark remaining steps as delegated --
        setSteps((prev) =>
            prev.map((s) => {
                if (s.id === "apply-config") {
                    return s;
                }
                return { ...s, status: "delegated" };
            })
        );

        // -- Launch systemd-run transient unit --
        resultsBuffer.push({
            type: "header",
            content: _("Delegating network activation and enrollment to background service"),
        });
        setResults([...resultsBuffer]);

        try {
            await cockpit.spawn(["sudo", SCRIPT_RUN_APPLY_ENROLL, masterParamsFile], { err: "message" });
        } catch (error) {
            console.error("Failed to launch systemd-run:", error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            onAction({
                id: "single-nic-launch-error",
                actionTitle: cockpit.format(
                    _(
                        "Configuration was applied, but network activation and enrollment could not be started in the background. $0"
                    ),
                    errorMsg || _("No additional error details were returned.")
                ),
                result: "error",
            });

            for (const f of tempFilesToCleanup) {
                cockpit.spawn(["rm", "-f", f], { err: "message" }).catch(() => {});
            }
            setSteps((prev) => prev.map((s) => (s.status === "delegated" ? { ...s, status: "failed" } : s)));
            await disarmWatchdog();
            updateModel("enrollmentProgress", { executionState: "failed" });
            return;
        }

        setSingleNic(true);
        updateModel("networkInterface", { wifiPassword: null });
        updateModel("enrollment", { credentials: null });
        updateModel("enrollmentProgress", {
            executionState: "success",
            overallProgress: 100,
            backgroundCompletion: true,
        });
    };

    // Main execution function
    const executeEnrollment = async () => {
        setHasStarted(true);
        shouldCancelRef.current = false;
        signalRef.current = { cancelled: false };
        updateModel("enrollmentProgress", { executionState: "running" });

        await writeAttemptedMarker(model);
        const testHost = model.connectivityTestHost;
        const watchdogTimeout = model.networkInterface.interfaceType === "wifi" ? 240 : 600;
        await armWatchdog(testHost, watchdogTimeout);

        const resultsBuffer: EnrollmentProgressResultItem[] = [];

        // Single-NIC: delegate network activation + enrollment to systemd-run
        if (await detectSingleNic()) {
            await executeSingleNicDelegation(resultsBuffer);
            return;
        }

        // Multi-NIC: execute all steps inline
        let completedSteps = 0;
        const totalSteps = steps.length;

        for (const step of steps) {
            if (shouldCancelRef.current) {
                console.log("Enrollment cancelled by user");
                await disarmWatchdog();
                updateModel("enrollmentProgress", { executionState: "failed" });
                return;
            }

            const stepHeader: EnrollmentProgressResultItem = {
                type: "header",
                content: step.name,
            };
            resultsBuffer.push(stepHeader);
            setResults([...resultsBuffer]);

            const onAction: OnStepAction = (action) => {
                upsertStepAction(resultsBuffer, action);
                setResults([...resultsBuffer]);
            };

            const result = await executeStep(step.id, onAction);

            setSteps((prev) =>
                prev.map((s) => {
                    if (s.id === step.id) {
                        const updatedStep: Step = {
                            ...s,
                            status: result.success ? "success" : "failed",
                        };
                        if (result.deviceUrl) {
                            updatedStep.deviceUrl = result.deviceUrl;
                        }
                        return updatedStep;
                    }
                    return s;
                })
            );

            if (result.success) {
                setExpandedStepIds((prev) => (prev.includes(step.id) ? prev : [...prev, step.id]));
                completedSteps++;
            } else if (step.id === "test-connectivity" && !model.connectivityTestRequired) {
                setSteps((prev) =>
                    prev.map((s) => (s.id === step.id ? { ...s, status: "warning" } : s))
                );
                setExpandedStepIds((prev) => (prev.includes(step.id) ? prev : [...prev, step.id]));
                completedSteps++;
            } else {
                const hasRollbackItems = Object.keys(rollbackManifestRef.current).length > 0;
                if (hasRollbackItems) {
                    const rollbackName = _("Reverting changes");
                    setSteps((prev) =>
                        prev.map((s) =>
                            s.id === "finalize" ? { ...s, name: rollbackName, status: "running" } : s
                        )
                    );
                    resultsBuffer.push({ type: "header", content: rollbackName });
                    setResults([...resultsBuffer]);

                    const rollbackOnAction: OnStepAction = (action) => {
                        upsertStepAction(resultsBuffer, action);
                        setResults([...resultsBuffer]);
                    };

                    const rollbackResult = await executeRollbackScript(
                        rollbackManifestRef.current,
                        rollbackOnAction
                    );

                    const hasErrors = rollbackResult.actions.some((a) => a.result === "error");
                    setSteps((prev) =>
                        prev.map((s) =>
                            s.id === "finalize"
                                ? { ...s, status: hasErrors ? "warning" : "success" }
                                : s
                        )
                    );
                    setExpandedStepIds((prev) =>
                        prev.includes("finalize") ? prev : [...prev, "finalize"]
                    );
                }
                await disarmWatchdog();
                updateModel("enrollmentProgress", { executionState: "failed" });
                return;
            }

            updateModel("enrollmentProgress", {
                overallProgress: Math.round((completedSteps / totalSteps) * 100),
            });

            if (completedSteps < totalSteps && ENROLLMENT_STEP_PAUSE_MS > 0) {
                await sleep(ENROLLMENT_STEP_PAUSE_MS);
                if (shouldCancelRef.current) {
                    await disarmWatchdog();
                    updateModel("enrollmentProgress", { executionState: "failed" });
                    return;
                }
            }
        }

        updateModel("networkInterface", { wifiPassword: null });
        updateModel("enrollment", { credentials: null });
        updateModel("enrollmentProgress", { executionState: "success" });
    };

    // Note: cleanup and reboot/finish actions are handled by the wizard footer in app.tsx

    // Set up cancellation handler
    useEffect(() => {
        cancelEnrollmentRef.current = () => {
            console.log("Cancellation requested");
            shouldCancelRef.current = true;
            signalRef.current.cancelled = true;

            if (signalRef.current.process) {
                console.log("Aborting running process");
                try {
                    signalRef.current.process.close();
                } catch (error) {
                    console.error("Error aborting process:", error);
                }
                signalRef.current.process = undefined;
            }
        };

        return () => {
            cancelEnrollmentRef.current = null;
        };
    }, [cancelEnrollmentRef]);

    // Auto-start enrollment when component mounts
    useEffect(() => {
        initializeSteps();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!isApplyAuthorized || steps.length === 0 || hasStarted) {
            return;
        }
        executeEnrollment();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isApplyAuthorized, steps, hasStarted]);

    const overallProgress =
        steps.length > 0 ? Math.round((steps.filter((s) => s.status === "success" || s.status === "warning").length / steps.length) * 100) : 0;
    const executionState = model.enrollmentProgress.executionState;
    const resultsByStep = groupResultsByStep(steps, results);
    const activeStepId = getActiveStepId(steps, executionState);

    useEffect(() => {
        if (!singleNic || executionState !== "success") {
            return;
        }

        const handleDelegatedFailure = (message: string) => {
            if (delegatedFailureHandledRef.current) {
                return;
            }
            delegatedFailureHandledRef.current = true;
            setDelegatedFailureMessage(message);
            const failureLines = message
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
            setSteps((prevSteps) => {
                setResults((prevResults) => {
                    const updated: EnrollmentProgressResultItem[] = [...prevResults];
                    updated.push({ type: "header", content: _("Testing network connectivity") });
                    updated.push({
                        type: "action",
                        action: makeStepAction(
                            ENROLLMENT_ACTION_IDS.BACKGROUND_CONNECTIVITY_CONFIRMED,
                            _("Network connectivity confirmed"),
                            "success"
                        ),
                    });

                    const enrollStep = prevSteps.find((step) => step.id.startsWith("enroll-"));
                    if (enrollStep) {
                        updated.push({ type: "header", content: enrollStep.name });
                    }

                    failureLines.forEach((line, index) => {
                        updated.push({
                            type: "action",
                            action: makeStepAction(`background-enrollment-failure-${index}`, line, "error"),
                        });
                    });
                    return updated;
                });

                return prevSteps.map((step) => {
                    if (step.id === "test-connectivity") {
                        return { ...step, status: "success" as const };
                    }
                    if (step.id.startsWith("enroll-")) {
                        return { ...step, status: "failed" as const };
                    }
                    if (step.id === "finalize" && step.status === "delegated") {
                        return { ...step, status: "pending" as const };
                    }
                    return step;
                });
            });
            updateModel("enrollmentProgress", { executionState: "failed" });
        };

        const pollWatchdogStatus = async () => {
            const status = await readWatchdogStatus();
            if (status?.status === "app_failure") {
                handleDelegatedFailure(status.message);
            }
        };

        pollWatchdogStatus().catch(() => {});
        const intervalId = window.setInterval(() => {
            pollWatchdogStatus().catch(() => {});
        }, 3000);

        return () => window.clearInterval(intervalId);
    }, [singleNic, executionState, updateModel]);

    useEffect(() => {
        if (!singleNic || executionState !== "success") {
            return;
        }

        const markerFile = cockpit.file(MARKER_COMPLETE, { superuser: "try" });
        const checkCompletionMarker = () => {
            markerFile
                .read()
                .then((content) => {
                    if (content !== null) {
                        window.location.reload();
                    }
                })
                .catch(() => {});
        };

        checkCompletionMarker();
        const intervalId = window.setInterval(checkCompletionMarker, 3000);
        return () => {
            window.clearInterval(intervalId);
            markerFile.close();
        };
    }, [singleNic, executionState]);

    useEffect(() => {
        if (!activeStepId) {
            return;
        }
        setExpandedStepIds([activeStepId]);
    }, [activeStepId]);

    const toggleStepExpanded = (stepId: string) => {
        setExpandedStepIds((prev) => (prev.includes(stepId) ? prev.filter((id) => id !== stepId) : [...prev, stepId]));
    };

    const renderStepDetails = (stepId: string) => {
        const stepResults = resultsByStep[stepId] ?? [];
        const contentItems = stepResults.filter((item) => item.type !== "header");
        if (contentItems.length === 0) {
            return null;
        }

        return (
            <Stack hasGutter className="pf-v6-u-font-size-sm pf-v6-u-pt-sm">
                {contentItems.flatMap((item, index) => {
                    if (item.type === "action") {
                        return (
                            <StackItem key={item.action.id}>
                                <StepActionRow action={item.action} />
                            </StackItem>
                        );
                    }

                    return item.content
                        .split("\n")
                        .map((line) => line.replace(/\r$/, ""))
                        .filter((line) => line.trim().length > 0)
                        .map((line, lineIndex) => (
                            <StackItem key={`${index}-${lineIndex}`}>
                                <Content>{line}</Content>
                            </StackItem>
                        ));
                })}
            </Stack>
        );
    };

    return (
        <Stack id="apply-content" hasGutter>
            <StackItem>
                <p>
                    {isEnrollmentSelected
                        ? _("Applying your configuration changes and enrolling this device.")
                        : _("Applying your configuration changes to this device.")}
                </p>
            </StackItem>

            <StackItem>
                <Card>
                    <CardBody>
                        <Progress
                            id="apply-progress"
                            title={_("Overall progress")}
                            value={overallProgress}
                            size="lg"
                            variant={executionState === "failed" ? "danger" : "success"}
                        />

                        <Title headingLevel="h3" size="md" className="pf-v6-u-mt-md">
                            {_("Steps")}
                        </Title>
                        <List isPlain id="apply-steps" className="pf-v6-u-mt-sm">
                            {steps.map((step) => {
                                const isFlightctlStep = step.id === `enroll-${FLIGHTCTL_SERVICE_ID}`;
                                const statusLabel = getStepStatusLabel(step.status);
                                const stepDetails = renderStepDetails(step.id);
                                const isExpanded = expandedStepIds.includes(step.id);
                                const toggleId = `enrollment-progress-step-${step.id}-toggle`;
                                const contentId = `enrollment-progress-step-${step.id}-content`;

                                return (
                                    <ListItem key={step.id}>
                                        <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
                                            <FlexItem>
                                                <Button
                                                    variant="plain"
                                                    aria-label={getStepStatusAriaLabel(step.status, step.name)}
                                                    {...(stepDetails && {
                                                        onClick: () => toggleStepExpanded(step.id),
                                                        "aria-expanded": isExpanded,
                                                    })}
                                                    isDisabled={!stepDetails}
                                                >
                                                    {getStepStatusIcon(step.status)}
                                                </Button>
                                            </FlexItem>
                                            <FlexItem flex={{ default: "flex_1" }}>
                                                {step.name}
                                                {step.deviceUrl && isFlightctlStep && (
                                                    <Button
                                                        variant="link"
                                                        className="pf-v6-u-ml-sm"
                                                        onClick={() => window.open(step.deviceUrl, "_blank")}
                                                    >
                                                        {cockpit.format(_("View in the $0 UI"), brandName)}
                                                    </Button>
                                                )}
                                            </FlexItem>
                                            {statusLabel && (
                                                <FlexItem>
                                                    <SubtleHeading text={statusLabel} />
                                                </FlexItem>
                                            )}
                                        </Flex>
                                        {stepDetails && (
                                            <div className="pf-v6-u-ml-md">
                                                <ExpandableSectionToggle
                                                    toggleId={toggleId}
                                                    contentId={contentId}
                                                    isExpanded={isExpanded}
                                                    onToggle={() => toggleStepExpanded(step.id)}
                                                >
                                                    {isExpanded ? _("Hide details") : _("View details")}
                                                </ExpandableSectionToggle>
                                                <ExpandableSection
                                                    isDetached
                                                    isExpanded={isExpanded}
                                                    toggleId={toggleId}
                                                    contentId={contentId}
                                                    isIndented
                                                >
                                                    {stepDetails}
                                                </ExpandableSection>
                                            </div>
                                        )}
                                    </ListItem>
                                );
                            })}
                        </List>

                        {executionState === "failed" && (
                            <Alert id="apply-failure-alert" variant="danger" title={_("Enrollment failed")} className="pf-v6-u-mt-md">
                                {delegatedFailureMessage ? (
                                    <Stack hasGutter>
                                        <StackItem>
                                            {_(
                                                "Background enrollment failed. Review the error details below and try again."
                                            )}
                                        </StackItem>
                                        <StackItem>
                                            {delegatedFailureMessage.split("\n").map((line, index) => (
                                                <Content key={index}>{line}</Content>
                                            ))}
                                        </StackItem>
                                    </Stack>
                                ) : (
                                    _(
                                        "The enrollment process was cancelled or failed. Applied changes have been reverted. Please check the step details and try again."
                                    )
                                )}
                            </Alert>
                        )}
                        {executionState === "success" && !singleNic && (
                            <Alert
                                id="apply-success-alert"
                                variant="success"
                                title={_("Configuration completed successfully")}
                                className="pf-v6-u-mt-md"
                            >
                                {_("Your system has been configured successfully.")}
                            </Alert>
                        )}
                        {executionState === "success" && singleNic && (
                            <Alert
                                id="apply-singlenic-alert"
                                variant="info"
                                title={_("Onboarding continues in the background")}
                                className="pf-v6-u-mt-md"
                            >
                                {_(
                                    "Network activation and enrollment continue in the background. Your browser connection will be lost when the new network configuration is applied. You do not need to click Finish — onboarding completes automatically. Progress is logged to /var/log/flightctl-onboarding-apply.log."
                                )}
                            </Alert>
                        )}
                    </CardBody>
                </Card>
            </StackItem>
        </Stack>
    );
};
