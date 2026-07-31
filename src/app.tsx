/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2017 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

import React, { useState, useEffect, useRef, createContext, useContext } from "react";
import { ExclamationCircleIcon } from "@patternfly/react-icons";
import { Button, ButtonVariant } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import {
    ActionList,
    ActionListGroup,
    ActionListItem,
} from "@patternfly/react-core/dist/esm/components/ActionList/index.js";
import { Form } from "@patternfly/react-core/dist/esm/components/Form/index";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Page, PageSection, PageSectionTypes } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import {
    Wizard,
    WizardBasicStep,
    WizardFooterWrapper,
    WizardStep,
} from "@patternfly/react-core/dist/esm/components/Wizard/index.js";

import cockpit from "cockpit";
import * as service from "service.js";
import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";
import { useEvent, useObject } from "hooks";
import { WithDialogs } from "dialogs.jsx";

import { NetworkManagerModel, Interface } from "../pkg/networkmanager/interfaces.js";

import { ModelProvider, useModelContext } from "./model-context";
import { loadConfig } from "./config-loader";
import { readAttemptedMarker, AttemptedMarkerData } from "./attempted-marker";
import { readWatchdogStatus } from "./services/watchdog";
import { SystemOnboardingConfig } from "./types";

import { NetworkPage } from "./wizard/NetworkPage.tsx";
import { NetworkServicesPage } from "./wizard/NetworkServicesPage.tsx";
import { EnrollmentPage } from "./wizard/EnrollmentPage.tsx";
import { EnrollmentProgressPage } from "./wizard/EnrollmentProgressPage.tsx";
import { LabelsPage } from "./wizard/LabelsPage.tsx";
import { ReviewPage } from "./wizard/ReviewPage.tsx";
import RestoredConfigurationSection, { WatchdogStatusData } from "./wizard/RestoredConfigurationSection.tsx";
import {
    stepIds,
    WIZARD_STEP_IDS,
    type WizardStepId,
    validateNetworkStep,
    validateEnrollmentStep,
    validateLabelsStep,
    validateNetworkServicesConfig,
    validateReviewStep,
} from "./wizard/WizardSteps.ts";

import { MARKER_COMPLETE, SCRIPT_CLEANUP } from "./paths";
import { invokeStatusHook } from "./services/status-hook";

const _ = cockpit.gettext;

interface OnboardingCompleteMarker {
    completedAt?: string;
    hostname?: string;
}

const getOnboardingCompleteMessage = (marker: OnboardingCompleteMarker | null): string => {
    const completedAt = marker?.completedAt?.trim();
    if (completedAt) {
        const date = new Date(completedAt);
        if (!isNaN(date.getTime())) {
            return cockpit.format(_("System onboarding was completed on $0."), date.toLocaleString());
        }
    }
    return _("System onboarding has already been completed on this device.");
};

// Configuration context to provide loaded configuration throughout the app
interface ConfigContextType {
    config: SystemOnboardingConfig | null;
    isConfigLoaded: boolean;
    configError: string | null;
}

const ConfigContext = createContext<ConfigContextType>({
    config: null,
    isConfigLoaded: false,
    configError: null,
});

export const useConfig = () => useContext(ConfigContext);

export const Application = () => {
    const [config, setConfig] = useState<SystemOnboardingConfig | null>(null);
    const [isConfigLoaded, setIsConfigLoaded] = useState(false);
    const [configError, setConfigError] = useState<string | null>(null);
    const [onboardingComplete, setOnboardingComplete] = useState(false);
    const [checkingMarker, setCheckingMarker] = useState(true);
    const [previousAttempt, setPreviousAttempt] = useState<AttemptedMarkerData | null>(null);
    const [watchdogStatus, setWatchdogStatus] = useState<WatchdogStatusData | null>(null);
    const [completionMarker, setCompletionMarker] = useState<OnboardingCompleteMarker | null>(null);

    const nmService = useObject(() => service.proxy("NetworkManager"), null, []);
    useEvent(nmService, "changed");

    const networkManager = useObject(() => new NetworkManagerModel(), null, []);
    useEvent(networkManager, "changed");

    const nmRunning_ref = useRef<boolean | undefined>(undefined);
    useEvent(networkManager.client, "owner", (_event, owner) => {
        nmRunning_ref.current = owner !== null;
    });

    // Check for onboarding completion marker file
    useEffect(() => {
        const markerFile = cockpit.file(MARKER_COMPLETE);

        markerFile
            .read()
            .then(async (content) => {
                if (content !== null) {
                    setOnboardingComplete(true);
                    try {
                        setCompletionMarker(JSON.parse(content) as OnboardingCompleteMarker);
                    } catch {
                        setCompletionMarker(null);
                    }
                    console.log("Onboarding already complete (marker file exists)");
                } else {
                    setOnboardingComplete(false);
                    console.log("Marker file does not exist - onboarding not complete");
                    const attempt = await readAttemptedMarker();
                    if (attempt) {
                        console.log("Previous attempt data found, will pre-populate wizard");
                        setPreviousAttempt(attempt);

                        const status = await readWatchdogStatus();
                        if (status) {
                            setWatchdogStatus(status);
                        }
                    }
                }
            })
            .catch((error) => {
                console.log("Error checking marker file:", error);
                setOnboardingComplete(false);
            })
            .finally(() => {
                setCheckingMarker(false);
                markerFile.close();
            });
    }, []);

    // Load configuration on mount
    useEffect(() => {
        const markerCheck = cockpit.file(MARKER_COMPLETE);
        Promise.all([loadConfig(), markerCheck.read()])
            .then(([loadedConfig, markerContent]) => {
                setConfig(loadedConfig);
                setIsConfigLoaded(true);
                console.log("Configuration loaded successfully:", loadedConfig);
                if (markerContent === null) {
                    invokeStatusHook(loadedConfig.statusHook, "in-progress");
                }
            })
            .catch((error) => {
                console.error("Failed to load configuration:", error);
                setConfigError(error.message || "Unknown error loading configuration");
                setIsConfigLoaded(true);
            })
            .finally(() => markerCheck.close());
    }, []);

    // Show loading while checking marker file or loading configuration
    if (checkingMarker || !isConfigLoaded || networkManager.ready === undefined) {
        return <EmptyStatePanel loading />;
    }

    // Show message if onboarding is already complete
    if (onboardingComplete) {
        return (
            <div id="system-onboarding-already-complete">
                <EmptyStatePanel
                    title={_("Onboarding complete")}
                    paragraph={getOnboardingCompleteMessage(completionMarker)}
                />
            </div>
        );
    }

    // Show error if configuration failed to load
    if (configError) {
        return (
            <div id="system-onboarding-config-error">
                <EmptyStatePanel
                    icon={ExclamationCircleIcon}
                    title={_("Configuration error")}
                    paragraph={configError}
                />
            </div>
        );
    }

    if (!nmRunning_ref.current) {
        if (nmService.enabled) {
            return (
                <div id="networking-nm-crashed">
                    <EmptyStatePanel
                        icon={ExclamationCircleIcon}
                        title={_("NetworkManager is not running")}
                        action={nmService.exists ? _("Start service") : null}
                        onAction={() => nmService.start()}
                        secondary={
                            <Button
                                component="a"
                                variant="secondary"
                                onClick={() =>
                                    cockpit.jump("/system/services#/NetworkManager.service", cockpit.transport.host)
                                }
                            >
                                {_("Troubleshoot…")}
                            </Button>
                        }
                    />
                </div>
            );
        } else if (!nmService.exists) {
            return (
                <div id="networking-nm-not-found">
                    <EmptyStatePanel icon={ExclamationCircleIcon} title={_("NetworkManager is not installed")} />
                </div>
            );
        } else {
            return (
                <div id="networking-nm-disabled">
                    <EmptyStatePanel
                        icon={ExclamationCircleIcon}
                        title={_("Network devices and graphs require NetworkManager")}
                        action={nmService.exists ? _("Enable service") : null}
                        onAction={() => {
                            nmService.enable();
                            nmService.start();
                        }}
                    />
                </div>
            );
        }
    }

    const interfaces = networkManager.list_interfaces();

    /* At this point NM is running, the model is ready, and configuration is loaded */
    return (
        <ConfigContext.Provider value={{ config, isConfigLoaded, configError }}>
            <ModelProvider networkManager={networkManager} config={config} previousAttempt={previousAttempt}>
                <WithDialogs key="1">
                    <SystemOnboardingWizardWrapper
                        interfaces={interfaces}
                        hasPreviousAttempt={Boolean(previousAttempt)}
                        watchdogStatus={watchdogStatus}
                    />
                </WithDialogs>
            </ModelProvider>
        </ConfigContext.Provider>
    );
};

// Wraps each page in a Form so that all PatternFly styles apply correctly.
// We can't wrap the entire wizard in a Form as it makes the steps adjust to the content height.
const FormWrapper = ({ children }: React.PropsWithChildren) => {
    return <Form onSubmit={(event) => event.preventDefault()}>{children}</Form>;
};

// Wrapper to wait for model initialization before showing wizard
const SystemOnboardingWizardWrapper: React.FunctionComponent<{
    interfaces: Interface[];
    hasPreviousAttempt: boolean;
    watchdogStatus?: WatchdogStatusData | null;
}> = ({ interfaces, hasPreviousAttempt, watchdogStatus }) => {
    const { isInitialized } = useModelContext();

    if (!isInitialized) {
        return <EmptyStatePanel loading />;
    }

    return (
        <SystemOnboardingWizard
            interfaces={interfaces}
            hasPreviousAttempt={hasPreviousAttempt}
            watchdogStatus={watchdogStatus}
        />
    );
};

const lockedProgressStages = ["idle", "running", "success"];

interface SystemOnboardingWizardProps {
    interfaces: Interface[];
    hasPreviousAttempt?: boolean;
    watchdogStatus?: WatchdogStatusData | null | undefined;
}

export const SystemOnboardingWizard: React.FunctionComponent<SystemOnboardingWizardProps> = ({
    interfaces,
    hasPreviousAttempt,
    watchdogStatus,
}) => {
    const { config } = useConfig();
    const { model, cancelEnrollmentRef } = useModelContext();
    const [maxReachedStep, setMaxReachedStep] = useState<WizardStepId>(WIZARD_STEP_IDS.network);
    const [activeStepId, setActiveStepId] = useState<WizardStepId>(WIZARD_STEP_IDS.network);
    const [showRestoredConfigurationSection, setShowRestoredConfigurationSection] = useState(hasPreviousAttempt);
    const [isCancelConfirmOpen, setIsCancelConfirmOpen] = useState(false);

    // It should not be possible to navigate to the "Apply" step via the navigation buttons.
    // The process must be always started from the "Review" step, by clicking the "Apply" button.
    const applyAuthorizedRef = useRef(false);
    const [isApplyAuthorized, setIsApplyAuthorized] = useState(false);

    const authorizeApply = () => {
        applyAuthorizedRef.current = true;
        setIsApplyAuthorized(true);
    };

    const resetApplyAuthorization = () => {
        applyAuthorizedRef.current = false;
        setIsApplyAuthorized(false);
    };

    const isEnrollmentSelected = model.enrollment.selected;
    const reviewButtonText = isEnrollmentSelected ? _("Enroll") : _("Apply");
    const finalStepName = isEnrollmentSelected ? _("Apply and enroll") : _("Apply configuration");

    // Compute validation state for each step
    const isNetworkStepValid = validateNetworkStep(model);
    const isNetworkServicesConfigValid = validateNetworkServicesConfig(model);
    const isEnrollmentStepValid = validateEnrollmentStep(model);
    const isLabelsStepValid = validateLabelsStep(model);
    const isReviewStepValid = validateReviewStep(model);

    // Map step index to validation state
    const stepValidations = [
        isNetworkStepValid,
        isNetworkServicesConfigValid,
        isEnrollmentStepValid,
        isLabelsStepValid,
        isReviewStepValid,
        true,
    ];

    const getStepValidation = (stepId: WizardStepId): boolean => {
        const index = stepIds.indexOf(stepId);
        return index >= 0 ? stepValidations[index] : false;
    };

    const enrollmentExecutionState = model.enrollmentProgress.executionState;
    const backgroundCompletion = Boolean(model.enrollmentProgress.backgroundCompletion);

    // It should not be possible to abandon the "Apply" step via the navigation buttons.
    // Once the user has reached that step, they must complete the process or cancel it.
    const isProgressStepNavigationLocked = () =>
        activeStepId === WIZARD_STEP_IDS.progress && lockedProgressStages.includes(enrollmentExecutionState);

    // Handle step navigation - using PatternFly Wizard's correct signature
    const handleStepChange = (
        _event: React.MouseEvent<HTMLButtonElement> | null,
        newStep: WizardBasicStep,
        prevStep?: WizardBasicStep
    ) => {
        const stepId = newStep.id.toString() as WizardStepId;
        const stepIndex = stepIds.indexOf(stepId);
        const maxReachIndex = stepIds.indexOf(maxReachedStep);

        setActiveStepId(stepId);

        if (prevStep?.id === WIZARD_STEP_IDS.progress && stepId !== WIZARD_STEP_IDS.progress) {
            resetApplyAuthorization();
        }

        // Update max reached step if user progresses forward with valid data
        if (stepIndex > maxReachIndex && getStepValidation(stepIds[maxReachIndex])) {
            setMaxReachedStep(stepId);
        }
    };

    // Users can only navigate to steps they've reached or the next step if current is valid
    const isStepDisabled = (stepId: WizardStepId): boolean => {
        if (isProgressStepNavigationLocked() && stepId !== WIZARD_STEP_IDS.progress) {
            return true;
        }

        if (stepId === WIZARD_STEP_IDS.progress && !applyAuthorizedRef.current) {
            return true;
        }

        const stepIndex = stepIds.indexOf(stepId);
        const maxReachIndex = stepIds.indexOf(maxReachedStep);

        if (stepIndex === -1) {
            return true;
        }

        // Users can go back to a step that has already been reached
        if (stepIndex <= maxReachIndex) {
            return false;
        }

        // Users can proceed to the next step only if the furthest reached step is valid
        if (stepIndex === maxReachIndex + 1 && getStepValidation(stepIds[maxReachIndex])) {
            return false;
        }

        // Cannot skip ahead past an invalid step
        return true;
    };

    useEffect(() => {
        if (enrollmentExecutionState !== "running") {
            setIsCancelConfirmOpen(false);
        }
    }, [enrollmentExecutionState]);

    const confirmApplyCancel = () => {
        setIsCancelConfirmOpen(false);
        if (cancelEnrollmentRef.current) {
            cancelEnrollmentRef.current();
        }
    };

    const getProgressPageFooter = () => {
        if (enrollmentExecutionState === "running") {
            // While running: disable Back, show a danger Cancel button that asks for confirmation
            return (
                <WizardFooterWrapper>
                    <ActionList>
                        <ActionListGroup>
                            <ActionListItem>
                                <Button variant={ButtonVariant.secondary} isDisabled>
                                    {_("Back")}
                                </Button>
                            </ActionListItem>
                            <ActionListItem>
                                <Button variant={ButtonVariant.danger} onClick={() => setIsCancelConfirmOpen(true)}>
                                    {_("Cancel")}
                                </Button>
                            </ActionListItem>
                        </ActionListGroup>
                    </ActionList>
                </WizardFooterWrapper>
            );
        } else if (enrollmentExecutionState === "success") {
            const wantReboot = config?.autoReboot === true;
            const runCleanup = () =>
                cockpit
                    .spawn(["sudo", SCRIPT_CLEANUP], { err: "message" })
                    .catch((error) => console.warn("Cleanup failed:", error));
            const handleFinish = async () => {
                if (!backgroundCompletion) {
                    await invokeStatusHook(config?.statusHook, "off");
                    await runCleanup();
                }
                if (wantReboot) {
                    cockpit
                        .spawn(["sudo", "shutdown", "-r", "now"], { err: "message" })
                        .catch((error) => console.error("Failed to trigger reboot:", error));
                } else {
                    window.location.reload();
                }
            };
            return {
                isBackDisabled: true,
                isNextDisabled: false,
                nextButtonText: backgroundCompletion
                    ? _("Reload")
                    : wantReboot
                      ? _("Finish & Reboot")
                      : _("Finish"),
                onNext: handleFinish,
                isCancelHidden: true,
            };
        } else if (enrollmentExecutionState === "failed") {
            // On failure: enable Back, disable Next
            return {
                isBackDisabled: false,
                isNextDisabled: true,
                nextButtonText: _("Finish"),
                isCancelHidden: true,
            };
        } else {
            // Default/idle state
            return {
                isBackDisabled: true,
                nextButtonText: _("Finish"),
                isCancelHidden: true,
            };
        }
    };

    return (
        <Page className="no-masthead-sidebar" id="system-onboarding-wizard">
            {showRestoredConfigurationSection && (
                <RestoredConfigurationSection
                    onDismiss={() => setShowRestoredConfigurationSection(false)}
                    watchdogStatus={watchdogStatus}
                />
            )}
            <PageSection
                hasBodyWrapper={false}
                type={PageSectionTypes.wizard}
                padding={{ default: "noPadding" }}
                aria-label="Wizard container"
            >
                <Wizard onStepChange={handleStepChange}>
                    <WizardStep
                        name={_("Network")}
                        id={WIZARD_STEP_IDS.network}
                        footer={{ isNextDisabled: !isNetworkStepValid, isCancelHidden: true }}
                    >
                        <FormWrapper>
                            <NetworkPage interfaces={interfaces} />
                        </FormWrapper>
                    </WizardStep>
                    <WizardStep
                        name={_("Network services")}
                        id={WIZARD_STEP_IDS.networkServices}
                        footer={{ isNextDisabled: !isNetworkServicesConfigValid, isCancelHidden: true }}
                        isDisabled={isStepDisabled(WIZARD_STEP_IDS.networkServices)}
                    >
                        <FormWrapper>
                            <NetworkServicesPage />
                        </FormWrapper>
                    </WizardStep>
                    <WizardStep
                        name={_("Enrollment")}
                        id={WIZARD_STEP_IDS.enrollment}
                        footer={{ isNextDisabled: !isEnrollmentStepValid, isCancelHidden: true }}
                        isDisabled={isStepDisabled(WIZARD_STEP_IDS.enrollment)}
                    >
                        <FormWrapper>
                            <EnrollmentPage />
                        </FormWrapper>
                    </WizardStep>
                    <WizardStep
                        name={_("Device labels")}
                        id={WIZARD_STEP_IDS.labels}
                        footer={{ isNextDisabled: !isLabelsStepValid, isCancelHidden: true }}
                        isDisabled={isStepDisabled(WIZARD_STEP_IDS.labels)}
                    >
                        <FormWrapper>
                            <LabelsPage />
                        </FormWrapper>
                    </WizardStep>
                    <WizardStep
                        name={_("Review")}
                        id={WIZARD_STEP_IDS.review}
                        footer={{
                            nextButtonText: reviewButtonText,
                            isNextDisabled: !isReviewStepValid,
                            isCancelHidden: true,
                            // onMouseDown runs before Next navigation checks whether the progress step is enabled
                            nextButtonProps: { id: "wizard-next-btn", onMouseDown: authorizeApply },
                        }}
                        isDisabled={isStepDisabled(WIZARD_STEP_IDS.review)}
                    >
                        <FormWrapper>
                            <ReviewPage hasSelectedEnrollments={isEnrollmentSelected} />
                        </FormWrapper>
                    </WizardStep>
                    <WizardStep
                        name={finalStepName}
                        id={WIZARD_STEP_IDS.progress}
                        footer={getProgressPageFooter()}
                        isDisabled={isStepDisabled(WIZARD_STEP_IDS.progress)}
                    >
                        <FormWrapper>
                            <EnrollmentProgressPage isApplyAuthorized={isApplyAuthorized} />
                        </FormWrapper>
                    </WizardStep>
                </Wizard>
            </PageSection>
            <Modal
                isOpen={isCancelConfirmOpen}
                onClose={() => setIsCancelConfirmOpen(false)}
                variant="small"
                aria-labelledby="cancel-apply-title"
                aria-describedby="cancel-apply-body"
            >
                <ModalHeader
                    title={_("Cancel applying changes?")}
                    titleIconVariant="warning"
                    labelId="cancel-apply-title"
                />
                <ModalBody id="cancel-apply-body">
                    {_(
                        "Applying changes is in progress. Cancelling will stop the process and roll back network changes."
                    )}
                </ModalBody>
                <ModalFooter>
                    <Button key="confirm" variant={ButtonVariant.danger} onClick={confirmApplyCancel}>
                        {_("Cancel applying changes")}
                    </Button>
                    <Button key="back" variant={ButtonVariant.link} onClick={() => setIsCancelConfirmOpen(false)}>
                        {_("Keep applying")}
                    </Button>
                </ModalFooter>
            </Modal>
        </Page>
    );
};
