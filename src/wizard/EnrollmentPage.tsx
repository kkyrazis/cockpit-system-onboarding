/**
 * Enrollment Page
 *
 * Allows users to enroll the device into Flight Control.
 */

import React, { useState, useEffect } from "react";
import cockpit from "cockpit";
import ExternalLinkAltIcon from "@patternfly/react-icons/dist/esm/icons/external-link-alt-icon";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio/index.js";
import { Stack, StackItem } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { List, ListItem } from "@patternfly/react-core/dist/esm/components/List/index.js";
import { Popover } from "@patternfly/react-core/dist/esm/components/Popover/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import HelpIcon from "@patternfly/react-icons/dist/esm/icons/help-icon";

import { useModelContext } from "../model-context";
import { useConfig } from "../app";
import { getBrandName } from "../flightctl-enrollment";
import { validateURL } from "../validation";
import ValidatedTextInput from "../components/ValidatedTextInput";
import FeatureSwitch from "../components/FeatureSwitch";
import { LabelHeading } from "../components/Headings";
import WithTooltip from "../components/WithTooltip";
import type {
    FlightctlAuthMethod,
    FlightctlPasswordCredentials,
    FlightctlTokenCredentials,
    ServiceEnrollmentConfig,
    TlsMode,
} from "../types";
import { detectFlightctlConfig } from "../services/flightctl-config";

const _ = cockpit.gettext;

export const EnrollmentPage = () => {
    const { config } = useConfig();
    const brandName = getBrandName(config);
    const { model, updateModel } = useModelContext();
    const enrollment = model.enrollment;
    const defaultEndpoint = config?.flightctl?.defaultEndpoint ?? "";
    const serviceEndpoint = enrollment.endpoint ?? defaultEndpoint;

    const [hasExistingCredentials, setHasExistingCredentials] = useState(false);
    const [existingServerUrl, setExistingServerUrl] = useState("");
    const [endpointTouched, setEndpointTouched] = useState(false);
    const [endpointError, setEndpointError] = useState<string | undefined>();

    const credentials = enrollment.credentials;
    const authMethod = credentials?.authMethod ?? "token";
    const tlsMode = enrollment.tlsMode ?? "system";
    const isUsingExisting = hasExistingCredentials && (enrollment.useExisting ?? false);
    const isEndpointFromExistingConfig = Boolean(existingServerUrl) && serviceEndpoint === existingServerUrl;

    const newToken = credentials?.authMethod === "token" ? credentials.token : "";
    const newUsername = credentials?.authMethod === "password" ? credentials.username : "";
    const newPassword = credentials?.authMethod === "password" ? credentials.password : "";

    const updateEnrollment = (patch: Partial<ServiceEnrollmentConfig>) => {
        updateModel("enrollment", patch);
    };

    const updateServiceCredentials = (patch: FlightctlTokenCredentials | FlightctlPasswordCredentials) => {
        updateModel("enrollment", {
            credentials: patch,
        });
    };

    useEffect(() => {
        let cancelled = false;

        detectFlightctlConfig().then((flightctlConfig) => {
            if (cancelled) {
                return;
            }
            setHasExistingCredentials(flightctlConfig.hasCredentials);
            setExistingServerUrl(flightctlConfig.serverUrl ?? defaultEndpoint);
            if (flightctlConfig.hasCredentials && enrollment.useExisting === undefined) {
                updateEnrollment({ useExisting: true });
            } else if (!flightctlConfig.hasCredentials) {
                updateEnrollment({ useExisting: false });
            }
        });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!enrollment.selected || isUsingExisting) {
            return;
        }
        setEndpointError(validateURL(serviceEndpoint, true) || undefined);
    }, [enrollment.selected, isUsingExisting, serviceEndpoint]);

    const handleEnrollmentToggle = (checked: boolean) => {
        if (!checked) {
            setEndpointTouched(false);
            setEndpointError(undefined);
        }
        updateEnrollment({ selected: checked });
    };

    const handleEndpointChange = (value: string) => {
        setEndpointTouched(true);
        setEndpointError(validateURL(value, true) || undefined);
        updateEnrollment({ endpoint: value });
    };

    const handleAuthMethodChange = (method: FlightctlAuthMethod) => {
        if (method === "token") {
            updateServiceCredentials({
                authMethod: "token",
                token: newToken,
            });
            return;
        }
        updateServiceCredentials({
            authMethod: "password",
            username: newUsername,
            password: newPassword,
        });
    };

    return (
        <Stack hasGutter>
            <StackItem>
                <Title headingLevel="h2" size="md">
                    {cockpit.format(_("$0 enrollment"), brandName)}
                </Title>
            </StackItem>

            <StackItem>
                <FeatureSwitch
                    fieldId="flightctl-enrollment"
                    label={cockpit.format(_("Enroll this device into $0"), brandName)}
                    isChecked={enrollment.selected}
                    onToggle={handleEnrollmentToggle}
                >
                    <Stack hasGutter>
                        <StackItem>
                            <LabelHeading text={_("Credentials")} />
                        </StackItem>
                        <StackItem>
                            <Stack hasGutter>
                                <StackItem>
                                    <WithTooltip
                                        showTooltip={!hasExistingCredentials}
                                        content={_("No existing credentials found")}
                                    >
                                        <Radio
                                            id="use-existing-flightctl"
                                            name="credential-mode-flightctl"
                                            label={_("Use existing")}
                                            isChecked={isUsingExisting}
                                            isDisabled={!hasExistingCredentials}
                                            onChange={() => updateEnrollment({ useExisting: true })}
                                            body={
                                                isUsingExisting && (
                                                    <FormGroup label={_("Server address:")}>
                                                        <TextInput
                                                            value={existingServerUrl || serviceEndpoint}
                                                            isDisabled
                                                        />
                                                    </FormGroup>
                                                )
                                            }
                                        />
                                    </WithTooltip>
                                </StackItem>
                                <StackItem>
                                    <Radio
                                        id="configure-new-flightctl"
                                        name="credential-mode-flightctl"
                                        label={_("Add a new credential")}
                                        isChecked={!isUsingExisting}
                                        onChange={() => updateEnrollment({ useExisting: false })}
                                        body={
                                            !isUsingExisting && (
                                                <Stack hasGutter>
                                                    <StackItem>
                                                        <FormGroup label={_("Authentication method")}>
                                                            <Stack hasGutter>
                                                                <StackItem>
                                                                    <Radio
                                                                        id="auth-token"
                                                                        name="auth-method"
                                                                        label={_("Token")}
                                                                        isChecked={authMethod === "token"}
                                                                        onChange={() => handleAuthMethodChange("token")}
                                                                        body={
                                                                            authMethod === "token" && (
                                                                                <FormGroup
                                                                                    label={_("Token")}
                                                                                    isRequired
                                                                                >
                                                                                    <TextArea
                                                                                        id="credential-token"
                                                                                        value={newToken}
                                                                                        onChange={(_event, value) =>
                                                                                            updateServiceCredentials({
                                                                                                authMethod: "token",
                                                                                                token: value,
                                                                                            })
                                                                                        }
                                                                                        rows={2}
                                                                                        isRequired
                                                                                    />
                                                                                    <Button
                                                                                        variant="link"
                                                                                        isInline
                                                                                        className="pf-v6-u-mt-sm"
                                                                                        iconPosition="end"
                                                                                        icon={<ExternalLinkAltIcon />}
                                                                                    >
                                                                                        {_("Where can I get my token?")}
                                                                                    </Button>
                                                                                </FormGroup>
                                                                            )
                                                                        }
                                                                    />
                                                                </StackItem>
                                                                <StackItem>
                                                                    <Radio
                                                                        id="auth-password"
                                                                        name="auth-method"
                                                                        label={_("Username and password")}
                                                                        isChecked={authMethod === "password"}
                                                                        onChange={() =>
                                                                            handleAuthMethodChange("password")
                                                                        }
                                                                        body={
                                                                            authMethod === "password" && (
                                                                                <>
                                                                                    <FormGroup
                                                                                        label={_("Username")}
                                                                                        isRequired
                                                                                    >
                                                                                        <TextInput
                                                                                            id="credential-username"
                                                                                            value={newUsername}
                                                                                            onChange={(_event, value) =>
                                                                                                updateServiceCredentials(
                                                                                                    {
                                                                                                        authMethod:
                                                                                                            "password",
                                                                                                        username: value,
                                                                                                        password:
                                                                                                            newPassword,
                                                                                                    }
                                                                                                )
                                                                                            }
                                                                                            isRequired
                                                                                        />
                                                                                    </FormGroup>
                                                                                    <FormGroup
                                                                                        label={_("Password")}
                                                                                        isRequired
                                                                                    >
                                                                                        <TextInput
                                                                                            id="credential-password"
                                                                                            type="password"
                                                                                            value={newPassword}
                                                                                            onChange={(_event, value) =>
                                                                                                updateServiceCredentials(
                                                                                                    {
                                                                                                        authMethod:
                                                                                                            "password",
                                                                                                        username:
                                                                                                            newUsername,
                                                                                                        password: value,
                                                                                                    }
                                                                                                )
                                                                                            }
                                                                                            isRequired
                                                                                        />
                                                                                    </FormGroup>
                                                                                </>
                                                                            )
                                                                        }
                                                                    />
                                                                </StackItem>
                                                            </Stack>
                                                        </FormGroup>
                                                    </StackItem>

                                                    <StackItem>
                                                        <Divider />
                                                    </StackItem>

                                                    <StackItem>
                                                        <FormGroup
                                                            label={cockpit.format(_("$0 server"), brandName)}
                                                            isRequired
                                                        >
                                                            <ValidatedTextInput
                                                                id="endpoint-flightctl"
                                                                value={serviceEndpoint}
                                                                onChange={(_event, value) =>
                                                                    handleEndpointChange(value)
                                                                }
                                                                {...(isEndpointFromExistingConfig && {
                                                                    helperText: _(
                                                                        "Auto-detected from the selected credential."
                                                                    ),
                                                                })}
                                                                error={endpointTouched ? endpointError : undefined}
                                                            />
                                                        </FormGroup>
                                                    </StackItem>

                                                    <StackItem>
                                                        <Divider />
                                                    </StackItem>

                                                    <StackItem>
                                                        <FormGroup label={_("TLS verification")}>
                                                            <Stack hasGutter>
                                                                <StackItem>
                                                                    <Radio
                                                                        id="tls-system"
                                                                        name="tls-mode"
                                                                        label={_("System default")}
                                                                        isChecked={tlsMode === "system"}
                                                                        onChange={() =>
                                                                            updateEnrollment({ tlsMode: "system" as TlsMode })
                                                                        }
                                                                    />
                                                                </StackItem>
                                                                <StackItem>
                                                                    <Radio
                                                                        id="tls-custom-ca"
                                                                        name="tls-mode"
                                                                        label={_("Custom CA certificate")}
                                                                        isChecked={tlsMode === "customCa"}
                                                                        onChange={() =>
                                                                            updateEnrollment({ tlsMode: "customCa" as TlsMode })
                                                                        }
                                                                        body={
                                                                            tlsMode === "customCa" && (
                                                                                <FormGroup label={_("CA certificate (PEM)")}>
                                                                                    <TextArea
                                                                                        id="ca-cert-pem"
                                                                                        value={enrollment.caCertPem ?? ""}
                                                                                        onChange={(_event, value) =>
                                                                                            updateEnrollment({ caCertPem: value })
                                                                                        }
                                                                                        rows={6}
                                                                                        placeholder={_(
                                                                                            "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
                                                                                        )}
                                                                                        style={{ fontFamily: "monospace" }}
                                                                                    />
                                                                                    <Popover
                                                                                        headerContent={_("Finding your CA certificate")}
                                                                                        bodyContent={
                                                                                            <List isPlain>
                                                                                                <ListItem>
                                                                                                    <strong>{_("Linux (quadlet):")}</strong>{" "}
                                                                                                    <code>sudo cat /etc/flightctl/pki/ca.crt</code>
                                                                                                </ListItem>
                                                                                                <ListItem>
                                                                                                    <strong>{_("Kubernetes (Helm):")}</strong>{" "}
                                                                                                    <code>kubectl get secret flightctl-ca -n &lt;namespace&gt; -o jsonpath=&apos;&#123;.data.tls\.crt&#125;&apos; | base64 -d</code>
                                                                                                </ListItem>
                                                                                            </List>
                                                                                        }
                                                                                    >
                                                                                        <Button
                                                                                            variant="link"
                                                                                            isInline
                                                                                            className="pf-v6-u-mt-sm"
                                                                                            icon={<HelpIcon />}
                                                                                            iconPosition="start"
                                                                                        >
                                                                                            {_("Where can I find the CA certificate?")}
                                                                                        </Button>
                                                                                    </Popover>
                                                                                </FormGroup>
                                                                            )
                                                                        }
                                                                    />
                                                                </StackItem>
                                                                <StackItem>
                                                                    <Radio
                                                                        id="tls-insecure"
                                                                        name="tls-mode"
                                                                        label={_("Skip verification (insecure)")}
                                                                        isChecked={tlsMode === "insecure"}
                                                                        onChange={() =>
                                                                            updateEnrollment({ tlsMode: "insecure" as TlsMode })
                                                                        }
                                                                        body={
                                                                            tlsMode === "insecure" && (
                                                                                <Alert
                                                                                    variant="warning"
                                                                                    isInline
                                                                                    isPlain
                                                                                    title={_(
                                                                                        "TLS verification is disabled. The connection to the server will not be verified. This is not recommended for production use."
                                                                                    )}
                                                                                />
                                                                            )
                                                                        }
                                                                    />
                                                                </StackItem>
                                                            </Stack>
                                                        </FormGroup>
                                                    </StackItem>
                                                </Stack>
                                            )
                                        }
                                    />
                                </StackItem>
                            </Stack>
                        </StackItem>
                    </Stack>
                </FeatureSwitch>
            </StackItem>
        </Stack>
    );
};
