import React, { useEffect } from "react";
import cockpit from "cockpit";

import { Stack, StackItem } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import {
    DescriptionList,
    DescriptionListGroup,
    DescriptionListTerm,
    DescriptionListDescription,
} from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/Label";
import { LabelGroup } from "@patternfly/react-core/dist/esm/components/Label/LabelGroup";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { useWizardContext } from "@patternfly/react-core/dist/esm/components/Wizard/index.js";
import { ExclamationTriangleIcon } from "@patternfly/react-icons";
import { Icon } from "@patternfly/react-core/dist/esm/components/Icon";

import FormHelperText from "../components/HelperTexts";
import { AliasMode, useModelContext } from "../model-context";
import { useConfig } from "../app";
import { getBrandName } from "../flightctl-enrollment";
import { useIsConnectedViaInterface } from "../hooks/useIsConnectedViaInterface";
import { resolveAliasValue } from "../services/alias";
import { WIZARD_STEP_IDS, type WizardStepId } from "./WizardSteps";
import { GenericLabel, ServiceEnrollmentConfig } from "../types";
import { validateHostnameOrIP } from "../validation";
import WithTooltip from "../components/WithTooltip";

const _ = cockpit.gettext;

interface ReviewPageProps {
    hasSelectedEnrollments: boolean;
}

interface ReviewSectionCardProps {
    id?: string;
    title: string;
    editStepId: WizardStepId;
    editAriaLabel: string;
    children: React.ReactNode;
}

const CUSTOM_INFO_PREFIX = "customInfo.";

const REVIEW_DESCRIPTION_LIST_ORIENTATION = {
    lg: "horizontal",
    xl: "horizontal",
    "2xl": "horizontal",
} as const;

const REVIEW_DESCRIPTION_LIST_TERM_WIDTH_STYLE = {
    "--pf-v6-c-description-list--m-horizontal__term--width-on-lg": "25ch",
    "--pf-v6-c-description-list--m-horizontal__term--width-on-xl": "25ch",
    "--pf-v6-c-description-list--m-horizontal__term--width-on-2xl": "25ch",
} as React.CSSProperties;

const toDisplayValue = (value: string): string => {
    if (value.startsWith(CUSTOM_INFO_PREFIX)) {
        return value.slice(CUSTOM_INFO_PREFIX.length);
    }
    return value;
};

const formatReviewLabelText = (label: GenericLabel): string => {
    const { key, value } = label;
    if (!value) {
        return key;
    }
    const displayValue = toDisplayValue(value);
    return `${key}=${displayValue}`;
};

interface ReviewLabelGroupProps {
    labels: GenericLabel[];
    compareKeys: string[];
    emptyLabel: string;
}

const ReviewLabelGroup = ({ labels, compareKeys, emptyLabel }: ReviewLabelGroupProps) => {
    // The empty labels from the form are only removed when applying the validation, so we need to filter them out here.
    const displayLabels = labels.filter((label) => label.key);
    if (displayLabels.length === 0) {
        return emptyLabel;
    }
    return (
        <LabelGroup numLabels={displayLabels.length}>
            {displayLabels.map((label, i) => {
                const isDuplicate = compareKeys.includes(label.key);
                return (
                    <WithTooltip
                        key={`${label.key}-${i}`}
                        showTooltip={isDuplicate}
                        content={cockpit.format(
                            _(
                                "A custom label is also defined with key '$0', which takes precedence over the system information mapping"
                            ),
                            label.key
                        )}
                    >
                        <Label>
                            {isDuplicate && (
                                <Icon status="warning" className="pf-v6-u-mr-sm">
                                    <ExclamationTriangleIcon />
                                </Icon>
                            )}
                            {formatReviewLabelText(label)}
                        </Label>
                    </WithTooltip>
                );
            })}
        </LabelGroup>
    );
};

const EnrollmentCardBody = ({
    enrollment,
    detectedServerUrl,
    defaultEndpoint,
    brandName,
}: {
    enrollment: ServiceEnrollmentConfig;
    detectedServerUrl: string;
    defaultEndpoint: string | undefined;
    brandName: string;
}) => {
    const { selected, useExisting, credentials } = enrollment;
    if (!selected) {
        return <span>{_("Enrollment skipped")}</span>;
    }

    const enrollmentEndpoint = (useExisting && detectedServerUrl) ? detectedServerUrl : (enrollment.endpoint ?? defaultEndpoint);
    const hasNewCredentials = selected && !useExisting;
    return (
        <>
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Enrollment certificate")}</DescriptionListTerm>
                <DescriptionListDescription>
                    {hasNewCredentials ? _("New enrollment certificate will be requested") : _("Using existing enrollment certificate")}
                </DescriptionListDescription>
            </DescriptionListGroup>
            {hasNewCredentials && (
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Authentication method")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {credentials?.authMethod === "token" ? _("Token") : _("Username and password")}
                        {credentials?.authMethod === "password" && (
                            <strong>{` (${_("username")}: ${credentials.username || _("(empty)")})`}</strong>
                        )}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
            <DescriptionListGroup>
                <DescriptionListTerm>{cockpit.format(_("$0 server"), brandName)}</DescriptionListTerm>
                <DescriptionListDescription>{enrollmentEndpoint}</DescriptionListDescription>
            </DescriptionListGroup>
            {hasNewCredentials && (
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("TLS verification")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {enrollment.tlsMode === "insecure"
                            ? (
                                <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                                    <FlexItem>
                                        <Icon status="warning">
                                            <ExclamationTriangleIcon />
                                        </Icon>
                                    </FlexItem>
                                    <FlexItem>{_("Skip verification (insecure)")}</FlexItem>
                                </Flex>
                            )
                            : enrollment.tlsMode === "customCa"
                                ? _("Custom CA certificate")
                                : _("System default")}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            )}
        </>
    );
};

const ReviewSectionCard = ({
    id,
    title,
    editStepId,
    editAriaLabel,
    children,
}: React.PropsWithChildren<ReviewSectionCardProps>) => {
    const { goToStepById } = useWizardContext();

    return (
        <Card isCompact>
            <CardBody>
                <Stack hasGutter>
                    <StackItem>
                        <Flex
                            justifyContent={{ default: "justifyContentSpaceBetween" }}
                            alignItems={{ default: "alignItemsCenter" }}
                        >
                            <FlexItem>
                                <Title headingLevel="h3" size="md">
                                    {title}
                                </Title>
                            </FlexItem>
                            <FlexItem>
                                <Button
                                    variant="link"
                                    isInline
                                    onClick={() => goToStepById(editStepId)}
                                    aria-label={editAriaLabel}
                                >
                                    {_("Edit")}
                                </Button>
                            </FlexItem>
                        </Flex>
                    </StackItem>
                    <StackItem>
                        <DescriptionList
                            id={id}
                            orientation={REVIEW_DESCRIPTION_LIST_ORIENTATION}
                            style={REVIEW_DESCRIPTION_LIST_TERM_WIDTH_STYLE}
                        >
                            {children}
                        </DescriptionList>
                    </StackItem>
                </Stack>
            </CardBody>
        </Card>
    );
};

export const ReviewPage: React.FunctionComponent<ReviewPageProps> = ({ hasSelectedEnrollments }) => {
    const { model, updateModel } = useModelContext();
    const { config } = useConfig();
    const brandName = getBrandName(config);

    const defaultEndpoint = config?.flightctl?.defaultEndpoint ?? "";

    useEffect(() => {
        if (model.connectivityTestHostEdited) {
            return;
        }

        const enrollment = model.enrollment;
        if (enrollment.selected) {
            let endpoint = enrollment.endpoint;
            if (enrollment.useExisting && model.detectedServerUrl) {
                endpoint = model.detectedServerUrl;
            } else if (!endpoint && !enrollment.useExisting) {
                endpoint = defaultEndpoint;
            }
            if (endpoint) {
                try {
                    const url = new URL(endpoint);
                    updateModel("connectivityTestHost", url.hostname);
                } catch {
                    updateModel("connectivityTestHost", endpoint);
                }
                return;
            }
        }

        const configHost = config?.connectivityTest?.host || "cockpit-project.org";
        updateModel("connectivityTestHost", configHost);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [model.enrollment, model.detectedServerUrl, defaultEndpoint]);

    const setConnectivityTestHost = (value: string) => {
        updateModel("connectivityTestHostEdited", true);
        updateModel("connectivityTestHost", value);
    };

    useEffect(() => {
        if (model.connectivityTestRequiredEdited) {
            return;
        }
        updateModel("connectivityTestRequired", config?.connectivityTest?.required ?? true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const setConnectivityTestRequired = (checked: boolean) => {
        updateModel("connectivityTestRequiredEdited", true);
        updateModel("connectivityTestRequired", checked);
    };

    const isSingleNic = useIsConnectedViaInterface(model.networkInterface.selectedInterface);

    const aliasSummary =
        model.alias.mode === AliasMode.NONE
            ? _("Not set")
            : resolveAliasValue(model.alias, model.hostname.value) || _("(empty)");

    return (
        <Stack hasGutter>
            <StackItem>
                <Alert variant="info" isInline title={_("Review your configuration")}>
                    {hasSelectedEnrollments
                        ? _(
                              'Please review your configuration below. Click "Enroll" to apply these settings and complete the system onboarding.'
                          )
                        : _(
                              'Please review your configuration below. Click "Apply" to apply these settings to the system.'
                          )}
                </Alert>
            </StackItem>

            {isSingleNic && (
                <StackItem>
                    <Alert id="review-singlenic-warning" variant="warning" isInline title={_("Connection will be interrupted")}>
                        {_(
                            "You are applying changes to the interface serving this browser session. Your connection will drop when the new network profile is activated. The remaining steps (connectivity test, enrollment, and cleanup) will continue in the background automatically."
                        )}
                    </Alert>
                </StackItem>
            )}

            <StackItem>
                <Stack hasGutter>
                    <StackItem>
                        <ReviewSectionCard
                            id="review-network"
                            title={_("Network")}
                            editStepId={WIZARD_STEP_IDS.network}
                            editAriaLabel={_("Edit network configuration")}
                        >
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Network interface")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {model.networkInterface.selectedInterface || _("(not selected)")}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            {model.networkInterface.interfaceType === "wifi" && (
                                <>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("WiFi SSID")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {model.networkInterface.wifiSsid || _("(empty)")}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("WiFi Security")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {model.networkInterface.wifiSecurity === "none" && _("None")}
                                            {model.networkInterface.wifiSecurity === "wep" && _("WEP")}
                                            {model.networkInterface.wifiSecurity === "wpa" && _("WPA/WPA2/WPA3")}
                                            {!model.networkInterface.wifiSecurity && _("(not set)")}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("WiFi Band")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {model.networkInterface.wifiBand === "bg" && _("2.4 GHz")}
                                            {model.networkInterface.wifiBand === "a" && _("5 GHz")}
                                            {(!model.networkInterface.wifiBand ||
                                                model.networkInterface.wifiBand === "auto") &&
                                                _("Auto")}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                </>
                            )}
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("VLAN ID")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {model.networkInterface.vlanEnabled && model.networkInterface.vlanId !== null
                                        ? model.networkInterface.vlanId
                                        : _("No VLAN")}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("IPv4 Connection")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {model.networkAddress.ipv4.method === "auto" && _("Automatic (DHCP)")}
                                    {model.networkAddress.ipv4.method === "static" && _("Static")}
                                    {model.networkAddress.ipv4.method === "disabled" && _("Disabled")}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            {model.networkAddress.ipv4.method === "static" && (
                                <>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("IPv4 Address")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {model.networkAddress.ipv4.address || _("(empty)")}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("IPv4 Subnet Mask")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {model.networkAddress.ipv4.subnetMask || _("(empty)")}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Gateway")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {model.networkAddress.ipv4.gateway || _("(empty)")}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                </>
                            )}
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("IPv4 DNS Configuration")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {model.networkAddress.ipv4.autoDns ? (
                                        _("Automatic")
                                    ) : (
                                        <>
                                            {model.networkAddress.ipv4.primaryDns && (
                                                <div>{model.networkAddress.ipv4.primaryDns}</div>
                                            )}
                                            {model.networkAddress.ipv4.secondaryDns && (
                                                <div>{model.networkAddress.ipv4.secondaryDns}</div>
                                            )}
                                            {!model.networkAddress.ipv4.primaryDns &&
                                                !model.networkAddress.ipv4.secondaryDns && <div>{_("(empty)")}</div>}
                                        </>
                                    )}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("IPv6 Connection")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {model.networkAddress.ipv6.method === "auto" && _("Automatic (SLAAC)")}
                                    {model.networkAddress.ipv6.method === "dhcp" && _("Stateful DHCPv6")}
                                    {model.networkAddress.ipv6.method === "static" && _("Static")}
                                    {model.networkAddress.ipv6.method === "disabled" && _("Disabled")}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            {model.networkAddress.ipv6.method === "static" && (
                                <>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("IPv6 Address")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {model.networkAddress.ipv6.address || _("(empty)")}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Gateway")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {model.networkAddress.ipv6.gateway || _("(empty)")}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                </>
                            )}
                            {model.networkAddress.ipv6.method !== "disabled" && (
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("IPv6 DNS Configuration")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        {model.networkAddress.ipv6.autoDns ? (
                                            _("Automatic")
                                        ) : (
                                            <>
                                                {model.networkAddress.ipv6.primaryDns && (
                                                    <div>{model.networkAddress.ipv6.primaryDns}</div>
                                                )}
                                                {model.networkAddress.ipv6.secondaryDns && (
                                                    <div>{model.networkAddress.ipv6.secondaryDns}</div>
                                                )}
                                                {!model.networkAddress.ipv6.primaryDns &&
                                                    !model.networkAddress.ipv6.secondaryDns && (
                                                        <div>{_("(empty)")}</div>
                                                    )}
                                            </>
                                        )}
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                            )}
                            {model.networkAddress.ipv6.method !== "disabled" && (
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("IPv6 required")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        {model.networkAddress.ipv6.mayFail ? _("No") : _("Yes")}
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                            )}
                        </ReviewSectionCard>
                    </StackItem>

                    <StackItem>
                        <ReviewSectionCard
                            id="review-network-services"
                            title={_("Network services")}
                            editStepId={WIZARD_STEP_IDS.networkServices}
                            editAriaLabel={_("Edit network services")}
                        >
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("NTP Server Hostname")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {model.networkServices.ntp.autoConfig ? (
                                        _("No custom NTP servers configured")
                                    ) : model.networkServices.ntp.servers.length > 0 ? (
                                        model.networkServices.ntp.servers.map((server, index) => (
                                            <div key={index}>{server}</div>
                                        ))
                                    ) : (
                                        <span>{_("(empty)")}</span>
                                    )}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("HTTP proxy")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {model.networkServices.proxy.enabled ? (
                                        <>
                                            {model.networkServices.proxy.hostname && model.networkServices.proxy.port
                                                ? `${model.networkServices.proxy.protocol}://${model.networkServices.proxy.hostname}:${model.networkServices.proxy.port}`
                                                : _("(incomplete configuration)")}
                                            {model.networkServices.proxy.username && (
                                                <div>
                                                    {_("Username: ")} {model.networkServices.proxy.username}
                                                </div>
                                            )}
                                            {model.networkServices.proxy.noProxy && (
                                                <div>
                                                    {_("No proxy: ")} {model.networkServices.proxy.noProxy}
                                                </div>
                                            )}
                                            {model.networkServices.proxy.protocol === "http" &&
                                                model.networkServices.proxy.applyForHttps && (
                                                    <div>{_("Also applies to HTTPS traffic")}</div>
                                                )}
                                        </>
                                    ) : (
                                        _("No proxy configured")
                                    )}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        </ReviewSectionCard>
                    </StackItem>

                    <StackItem>
                        <ReviewSectionCard
                            id="review-enrollment"
                            title={_("Enrollment")}
                            editStepId={WIZARD_STEP_IDS.enrollment}
                            editAriaLabel={_("Edit enrollment")}
                        >
                            <EnrollmentCardBody
                                enrollment={model.enrollment}
                                detectedServerUrl={model.detectedServerUrl}
                                defaultEndpoint={config?.flightctl?.defaultEndpoint}
                                brandName={brandName}
                            />
                        </ReviewSectionCard>
                    </StackItem>

                    <StackItem>
                        <Card isCompact>
                            <CardBody>
                                <Stack hasGutter>
                                    <StackItem>
                                        <Title headingLevel="h3" size="md">
                                            {_("Connectivity test")}
                                        </Title>
                                    </StackItem>
                                    <StackItem>
                                        <FormGroup
                                            label={_("Host")}
                                            isRequired
                                        >
                                            <TextInput
                                                id="review-connectivity-test-host"
                                                value={model.connectivityTestHost}
                                                onChange={(_event, value) =>
                                                    setConnectivityTestHost(value)
                                                }
                                                isRequired
                                                validated={
                                                    validateHostnameOrIP(model.connectivityTestHost) === null
                                                        ? "default"
                                                        : "error"
                                                }
                                            />
                                            <FormHelperText
                                                content={
                                                    validateHostnameOrIP(model.connectivityTestHost) ??
                                                    _(
                                                        "Network connectivity to this host will be verified after applying network changes."
                                                    )
                                                }
                                                variant={
                                                    validateHostnameOrIP(model.connectivityTestHost) === null
                                                        ? "default"
                                                        : "error"
                                                }
                                            />
                                        </FormGroup>
                                    </StackItem>
                                    <StackItem>
                                        <Checkbox
                                            id="review-connectivity-test-required"
                                            label={_("Required")}
                                            isChecked={model.connectivityTestRequired}
                                            onChange={(_event, checked) => setConnectivityTestRequired(checked)}
                                            description={
                                                model.connectivityTestRequired
                                                    ? _("Enrollment will stop and changes will be rolled back if the connectivity test fails.")
                                                    : _("A connectivity test failure will show a warning but enrollment will continue.")
                                            }
                                        />
                                    </StackItem>
                                </Stack>
                            </CardBody>
                        </Card>
                    </StackItem>

                    <StackItem>
                        <ReviewSectionCard
                            id="review-device-labels"
                            title={_("Device labels")}
                            editStepId={WIZARD_STEP_IDS.labels}
                            editAriaLabel={_("Edit device labels")}
                        >
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Hostname")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {model.hostname.value || _("(empty)")}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Alias")}</DescriptionListTerm>
                                <DescriptionListDescription>{aliasSummary}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Custom labels")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ReviewLabelGroup
                                        labels={model.labels.deviceLabels}
                                        compareKeys={[]}
                                        emptyLabel={_("No custom labels configured")}
                                    />
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("System information mappings")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ReviewLabelGroup
                                        labels={model.labels.systemInfoMappings}
                                        compareKeys={model.labels.deviceLabels.map((label) => label.key)}
                                        emptyLabel={_("No system information mappings configured")}
                                    />
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        </ReviewSectionCard>
                    </StackItem>
                </Stack>
            </StackItem>
        </Stack>
    );
};
