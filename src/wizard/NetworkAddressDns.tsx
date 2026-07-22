import React from "react";
import cockpit from "cockpit";

import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio/index.js";
import { Stack, StackItem } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { LabelHeading } from "../components/Headings";
import ValidatedTextInput from "../components/ValidatedTextInput";
import ValidatedRadioLabel from "../components/ValidatedRadioLabel";
import { useModelContext } from "../model-context";
import { validateDns, validateIpv4DnsConfig, validateIpv6DnsConfig } from "../validation";

const _ = cockpit.gettext;

type IpVersion = "ipv4" | "ipv6";

const placeholders = {
    ipv4: {
        primary: _("e.g. 8.8.8.8"),
        secondary: _("e.g. 8.8.4.4"),
    },
    ipv6: {
        primary: _("e.g. 2001:4860:4860::8888"),
        secondary: _("e.g. 2001:4860:4860::8844"),
    },
};

export const NetworkAddressDns = ({ version }: { version: IpVersion }) => {
    const { model, updateNestedModel } = useModelContext();
    const dnsConfig = model.networkAddress[version];

    const [validationErrors, setValidationErrors] = React.useState({
        primaryDns: null as string | null,
        secondaryDns: null as string | null,
    });

    const setAutoDns = (autoDns: boolean) => {
        updateNestedModel("networkAddress", version, { autoDns });
        if (autoDns) {
            setValidationErrors((prev) => ({ ...prev, primaryDns: null, secondaryDns: null }));
        }
    };

    const setPrimaryDns = (primaryDns: string) => {
        const error = validateDns(primaryDns, version, !dnsConfig.autoDns);
        setValidationErrors((prev) => ({ ...prev, primaryDns: error }));
        updateNestedModel("networkAddress", version, { primaryDns });
    };

    const setSecondaryDns = (secondaryDns: string) => {
        const error = validateDns(secondaryDns, version, false);
        setValidationErrors((prev) => ({ ...prev, secondaryDns: error }));
        updateNestedModel("networkAddress", version, { secondaryDns });
    };

    const isValidManualDns =
        dnsConfig.autoDns ||
        (version === "ipv4"
            ? validateIpv4DnsConfig(model.networkAddress.ipv4)
            : validateIpv6DnsConfig(model.networkAddress.ipv6));

    return (
        <Stack hasGutter>
            <StackItem>
                <LabelHeading text={version === "ipv4" ? _("IPv4 DNS Configuration") : _("IPv6 DNS Configuration")} />
            </StackItem>
            <StackItem>
                <Radio
                    id={`auto-dns-${version}-radio`}
                    name={`${version}-dns-method`}
                    label={_("Automatic")}
                    isChecked={dnsConfig.autoDns}
                    onChange={() => setAutoDns(true)}
                />
            </StackItem>
            <StackItem>
                <Radio
                    id={`manual-dns-${version}-radio`}
                    name={`${version}-dns-method`}
                    label={<ValidatedRadioLabel label={_("Manual")} isValid={isValidManualDns} />}
                    isChecked={!dnsConfig.autoDns}
                    onChange={() => setAutoDns(false)}
                    body={
                        !dnsConfig.autoDns && (
                            <Stack hasGutter>
                                <StackItem>
                                    <FormGroup label={_("Primary Server")} isRequired>
                                        <ValidatedTextInput
                                            id={`primary-dns-${version}`}
                                            value={dnsConfig.primaryDns || ""}
                                            error={validationErrors.primaryDns}
                                            onChange={(_, value) => setPrimaryDns(value)}
                                            placeholder={placeholders[version].primary}
                                        />
                                    </FormGroup>
                                </StackItem>
                                <StackItem>
                                    <FormGroup label={_("Secondary Server")}>
                                        <ValidatedTextInput
                                            id={`secondary-dns-${version}`}
                                            value={dnsConfig.secondaryDns || ""}
                                            onChange={(_, value) => setSecondaryDns(value)}
                                            placeholder={placeholders[version].secondary}
                                            error={validationErrors.secondaryDns}
                                        />
                                    </FormGroup>
                                </StackItem>
                            </Stack>
                        )
                    }
                />
            </StackItem>
        </Stack>
    );
};
