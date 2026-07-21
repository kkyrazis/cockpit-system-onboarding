import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import { systemConfigurationService } from "./system-config.js";
import { Interface, NetworkManagerModel } from "../pkg/networkmanager/interfaces.js";
import {
    HostnameState,
    NetworkInterfaceState,
    NetworkAddressState,
    NetworkServicesState,
    LabelsState,
    ServiceEnrollmentConfig,
    SystemOnboardingConfig,
} from "./types";
import { detectFlightctlConfig } from "./services/flightctl-config";
import { DEFAULT_ENROLLMENT_CONFIG, patchEnrollment, restoreEnrollmentFromMarker } from "./enrollment-state";
import { parseIpv6Address, ConnectionIpSettings } from "./services/network";
import { resolveDefaultAliasMode } from "./services/alias.js";
import { AttemptedMarkerData } from "./attempted-marker";

export enum AliasMode {
    HOSTNAME = "hostname",
    CUSTOM = "custom",
    NONE = "none",
}

export interface AliasState {
    mode: AliasMode;
    customValue: string;
}

// NetworkAddressConfig - internal type for compatibility with existing code
// Uses string instead of string | null for backward compatibility
interface NetworkAddressConfig {
    ipv4: {
        method: "dhcp" | "static" | "auto" | "disabled";
        address: string;
        subnetMask: string;
        gateway: string;
        autoDns: boolean;
        primaryDns: string;
        secondaryDns: string;
    };
    ipv6: {
        method: "dhcp" | "static" | "auto" | "disabled";
        address: string;
        gateway: string;
        autoDns: boolean;
        primaryDns: string;
        secondaryDns: string;
    };
}

export interface Model {
    hostname: HostnameState;
    alias: AliasState;
    networkInterface: NetworkInterfaceState;
    networkAddress: NetworkAddressState;
    // Store original interface configurations for quick switching (internal format)
    originalNetworkConfigs: { [interfaceName: string]: NetworkAddressConfig };
    // Store user-modified configurations per interface (internal format)
    userNetworkConfigs: { [interfaceName: string]: NetworkAddressConfig };
    networkServices: NetworkServicesState;
    enrollment: ServiceEnrollmentConfig;
    labels: LabelsState;
    detectedServerUrl: string;
    connectivityTestHost: string;
    connectivityTestHostEdited: boolean;
    connectivityTestRequired: boolean;
    connectivityTestRequiredEdited: boolean;
    enrollmentProgress: {
        currentStep: number; // 0-3
        stepStates: ("pending" | "running" | "success" | "error")[];
        logs: string[]; // execution logs
        executionState: "idle" | "running" | "success" | "failed"; // overall execution state
        canCancel: boolean; // whether cancellation is possible
        overallProgress: number; // 0-100 percentage
        backgroundCompletion?: boolean; // single-NIC: apply-and-enroll.sh finishes without UI Finish
    };
}

// Default network address configuration (internal format)
const defaultNetworkConfig: NetworkAddressConfig = {
    ipv4: {
        method: "auto",
        address: "",
        subnetMask: "",
        gateway: "",
        autoDns: true,
        primaryDns: "",
        secondaryDns: "",
    },
    ipv6: {
        method: "auto",
        address: "",
        gateway: "",
        autoDns: true,
        primaryDns: "",
        secondaryDns: "",
    },
};

// Initial state
const initialModel: Model = {
    hostname: {
        value: "",
        dhcpHostname: "",
    },
    networkInterface: {
        selectedInterface: null,
        interfaceType: null,
        wifiSsid: null,
        wifiPassword: null,
        wifiSecurity: null,
        wifiBand: null,
        vlanEnabled: false,
        vlanId: null,
    },
    networkAddress: {
        ipv4: {
            method: "auto",
            address: null,
            subnetMask: null,
            gateway: null,
            autoDns: true,
            primaryDns: null,
            secondaryDns: null,
        },
        ipv6: {
            method: "auto",
            address: null,
            gateway: null,
            autoDns: true,
            primaryDns: null,
            secondaryDns: null,
        },
    },
    originalNetworkConfigs: {},
    userNetworkConfigs: {},
    networkServices: {
        ntp: {
            autoConfig: true,
            servers: [],
        },
        proxy: {
            enabled: false,
            protocol: "http",
            applyForHttps: true,
            hostname: null,
            port: null,
            username: null,
            password: null,
            noProxy: "localhost,127.0.0.1,::1",
        },
    },
    enrollment: { ...DEFAULT_ENROLLMENT_CONFIG },
    alias: {
        mode: AliasMode.HOSTNAME,
        customValue: "",
    },
    labels: {
        deviceLabels: [],
        systemInfoMappings: [],
    },
    detectedServerUrl: "",
    connectivityTestHost: "",
    connectivityTestHostEdited: false,
    connectivityTestRequired: true,
    connectivityTestRequiredEdited: false,
    enrollmentProgress: {
        currentStep: 0,
        stepStates: ["pending", "pending", "pending", "pending"],
        logs: [],
        executionState: "idle",
        canCancel: false,
        overallProgress: 0,
    },
};

// Context type combining existing NetworkManager model and application model
type ModelSectionUpdate<T extends keyof Model> = Model[T] extends object ? Partial<Model[T]> : Model[T];

interface ModelContextType {
    networkManager?: NetworkManagerModel | undefined;
    model: Model;
    isInitialized: boolean;
    updateModel: <T extends keyof Model>(section: T, updates: ModelSectionUpdate<T>) => void;
    updateNestedModel: <T extends keyof Model, K extends keyof Model[T]>(
        section: T,
        subsection: K,
        updates: Partial<Model[T][K]>
    ) => void;
    switchToInterfaceConfig: (interfaceName: string) => void;
    saveCurrentNetworkConfig: () => void;
    parseIpv6Address: (addressWithPrefix: string) => { address: string; prefix: number };
    formatIpv6Address: (address: string, prefix: number) => string;
    cancelEnrollmentRef: React.MutableRefObject<(() => void) | null>;
}

// Create context
export const ModelContext = createContext<ModelContextType | undefined>(undefined);

// Helper to convert NetworkAddressState to NetworkAddressConfig (for internal use)
const stateToConfig = (state: NetworkAddressState): NetworkAddressConfig => {
    return {
        ipv4: {
            method: state.ipv4.method,
            address: state.ipv4.address ?? "",
            subnetMask: state.ipv4.subnetMask ?? "",
            gateway: state.ipv4.gateway ?? "",
            autoDns: state.ipv4.autoDns,
            primaryDns: state.ipv4.primaryDns ?? "",
            secondaryDns: state.ipv4.secondaryDns ?? "",
        },
        ipv6: {
            method: state.ipv6.method,
            address: state.ipv6.address ?? "",
            gateway: state.ipv6.gateway ?? "",
            autoDns: state.ipv6.autoDns,
            primaryDns: state.ipv6.primaryDns ?? "",
            secondaryDns: state.ipv6.secondaryDns ?? "",
        },
    };
};

// Helper to convert NetworkAddressConfig to NetworkAddressState
const configToState = (config: NetworkAddressConfig): NetworkAddressState => {
    const mapIpv4Method = (method: "dhcp" | "static" | "auto" | "disabled"): "auto" | "static" | "disabled" => {
        return method === "dhcp" ? "auto" : method;
    };

    const mapIpv6Method = (
        method: "dhcp" | "static" | "auto" | "disabled"
    ): "auto" | "dhcp" | "static" | "disabled" => {
        return method;
    };

    return {
        ipv4: {
            method: mapIpv4Method(config.ipv4.method),
            address: config.ipv4.address || null,
            subnetMask: config.ipv4.subnetMask || null,
            gateway: config.ipv4.gateway || null,
            autoDns: config.ipv4.autoDns,
            primaryDns: config.ipv4.primaryDns || null,
            secondaryDns: config.ipv4.secondaryDns || null,
        },
        ipv6: {
            method: mapIpv6Method(config.ipv6.method),
            address: config.ipv6.address || null,
            gateway: config.ipv6.gateway || null,
            autoDns: config.ipv6.autoDns,
            primaryDns: config.ipv6.primaryDns || null,
            secondaryDns: config.ipv6.secondaryDns || null,
        },
    };
};

// Helper function to convert prefix length to subnet mask
const prefixToSubnetMask = (prefix: number): string => {
    if (prefix < 0 || prefix > 32) {
        return "";
    }

    const mask = (-1 << (32 - prefix)) >>> 0;
    return [(mask >>> 24) & 255, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join(".");
};

// Helper function to format IPv6 address with prefix
export const formatIpv6Address = (address: string, prefix: number): string => {
    if (!address) {
        return "";
    }
    return `${address}/${prefix}`;
};

// Helper function to extract network configuration from an interface
const extractNetworkConfig = (iface: Interface): NetworkAddressConfig => {
    const config: NetworkAddressConfig = { ...defaultNetworkConfig };

    if (!iface.Device || !iface.Device.ActiveConnection) {
        return config;
    }

    const activeConnection = iface.Device.ActiveConnection;

    // IPv4 configuration
    const ipv4Settings = iface.MainConnection?.Settings.ipv4 as ConnectionIpSettings | undefined;
    const ipv4Method = ipv4Settings?.method || "dhcp";
    const ipv4ConnectionDns = ipv4Settings?.dns || [];

    if (
        activeConnection.Ip4Config &&
        activeConnection.Ip4Config.Addresses &&
        activeConnection.Ip4Config.Addresses.length > 0
    ) {
        const address = activeConnection.Ip4Config.Addresses[0];
        // Get DNS servers from active config (includes DHCP-provided DNS) and connection settings
        const activeDns = activeConnection.Ip4Config.Nameservers || [];
        const hasStaticDns = ipv4ConnectionDns.length > 0;
        const dnsServers = hasStaticDns ? ipv4ConnectionDns : activeDns;

        config.ipv4 = {
            ...config.ipv4,
            method: ipv4Method === "manual" ? "static" : ipv4Method === "disabled" ? "disabled" : "dhcp",
            address: address[0] || "",
            subnetMask: address[1] ? prefixToSubnetMask(Number(address[1])) : "",
            gateway: address[2] || "",
            autoDns: !hasStaticDns,
            primaryDns: dnsServers[0] || "",
            secondaryDns: dnsServers[1] || "",
        };
    } else if (ipv4ConnectionDns.length > 0) {
        // Handle case where there are DNS settings but no active addresses
        config.ipv4 = {
            ...config.ipv4,
            method: ipv4Method === "manual" ? "static" : ipv4Method === "disabled" ? "disabled" : "dhcp",
            autoDns: false,
            primaryDns: ipv4ConnectionDns[0] || "",
            secondaryDns: ipv4ConnectionDns[1] || "",
        };
    }

    // IPv6 configuration
    const ipv6Settings = iface.MainConnection?.Settings.ipv6 as ConnectionIpSettings | undefined;
    const ipv6Method = ipv6Settings?.method || "dhcp";
    const ipv6ConnectionDns = ipv6Settings?.dns || [];

    if (
        activeConnection.Ip6Config &&
        activeConnection.Ip6Config.Addresses &&
        activeConnection.Ip6Config.Addresses.length > 0
    ) {
        const address = activeConnection.Ip6Config.Addresses[0];
        // Get DNS servers from active config (includes DHCP-provided DNS) and connection settings
        const activeDns = activeConnection.Ip6Config.Nameservers || [];
        const hasStaticDns = ipv6ConnectionDns.length > 0;
        const dnsServers = hasStaticDns ? ipv6ConnectionDns : activeDns;

        config.ipv6 = {
            ...config.ipv6,
            method:
                ipv6Method === "manual"
                    ? "static"
                    : ipv6Method === "ignore"
                      ? "disabled"
                      : ipv6Method === "dhcp"
                        ? "dhcp"
                        : "auto",
            address: address[0] && address[1] ? `${address[0]}/${address[1]}` : address[0] || "",
            gateway: address[2] || "",
            autoDns: !hasStaticDns,
            primaryDns: dnsServers[0] || "",
            secondaryDns: dnsServers[1] || "",
        };
    } else if (ipv6ConnectionDns.length > 0) {
        // Handle case where there are DNS settings but no active addresses
        config.ipv6 = {
            ...config.ipv6,
            method:
                ipv6Method === "manual"
                    ? "static"
                    : ipv6Method === "ignore"
                      ? "disabled"
                      : ipv6Method === "dhcp"
                        ? "dhcp"
                        : "auto",
            autoDns: false,
            primaryDns: ipv6ConnectionDns[0] || "",
            secondaryDns: ipv6ConnectionDns[1] || "",
        };
    }

    return config;
};

// Provider component
export const ModelProvider: React.FunctionComponent<{
    children: ReactNode;
    networkManager?: NetworkManagerModel | undefined;
    config?: SystemOnboardingConfig | null;
    previousAttempt?: AttemptedMarkerData | null;
}> = ({ children, networkManager, config, previousAttempt }) => {
    const [model, setModel] = useState<Model>(initialModel);
    const [isInitialized, setIsInitialized] = useState<boolean>(false);
    const cancelEnrollmentRef = useRef<(() => void) | null>(null);

    const updateModel = <T extends keyof Model>(section: T, updates: ModelSectionUpdate<T>) => {
        setModel((prev) => {
            if (typeof updates !== "object" || updates === null) {
                return { ...prev, [section]: updates };
            }
            return {
                ...prev,
                [section]: {
                    ...(prev[section] as object),
                    ...(updates as object),
                },
            };
        });
    };

    const updateNestedModel = <T extends keyof Model, K extends keyof Model[T]>(
        section: T,
        subsection: K,
        updates: Partial<Model[T][K]>
    ) => {
        setModel((prev) => {
            const prevSection = prev[section];
            const prevSubsection = prevSection[subsection];

            const newModel = {
                ...prev,
                [section]: {
                    ...(prevSection as object),
                    [subsection]: {
                        ...(prevSubsection as object),
                        ...updates,
                    },
                },
            };

            // Auto-save user network config when networkAddress is updated
            if (section === "networkAddress" && prev.networkInterface.selectedInterface) {
                newModel.userNetworkConfigs = {
                    ...prev.userNetworkConfigs,
                    [prev.networkInterface.selectedInterface]: stateToConfig(newModel.networkAddress),
                };
            }

            return newModel;
        });
    };

    const switchToInterfaceConfig = (interfaceName: string) => {
        // Save current changes to the previously selected interface
        const currentSelectedInterface = model.networkInterface.selectedInterface;
        if (currentSelectedInterface && currentSelectedInterface !== interfaceName) {
            setModel((prev) => ({
                ...prev,
                userNetworkConfigs: {
                    ...prev.userNetworkConfigs,
                    [currentSelectedInterface]: stateToConfig(prev.networkAddress),
                },
            }));
        }

        // Load configuration for the new interface (user config takes priority over original)
        const userConfig = model.userNetworkConfigs[interfaceName];
        const originalConfig = model.originalNetworkConfigs[interfaceName];
        const configToUse = userConfig || originalConfig || defaultNetworkConfig;

        setModel((prev) => ({
            ...prev,
            networkAddress: configToState(configToUse),
        }));
    };

    const saveCurrentNetworkConfig = () => {
        const currentSelectedInterface = model.networkInterface.selectedInterface;
        if (currentSelectedInterface) {
            setModel((prev) => ({
                ...prev,
                userNetworkConfigs: {
                    ...prev.userNetworkConfigs,
                    [currentSelectedInterface]: stateToConfig(prev.networkAddress),
                },
            }));
        }
    };

    const initializeFromSystem = async () => {
        if (!networkManager) {
            console.warn("Cannot initialize: networkManager is not available");
            setIsInitialized(true);
            return;
        }

        if (!networkManager.ready) {
            console.warn("Cannot initialize: networkManager is not ready");
            setIsInitialized(true);
            return;
        }

        try {
            const interfaces: Interface[] = networkManager.list_interfaces();
            const systemInfo = await systemConfigurationService.getSystemInfo(interfaces);

            // Extract network configurations for all interfaces
            const originalConfigs: { [interfaceName: string]: NetworkAddressConfig } = {};
            interfaces.forEach((iface) => {
                originalConfigs[iface.Name] = extractNetworkConfig(iface);
            });

            // Get default interface configuration
            const defaultConfig =
                systemInfo.defaultInterface && originalConfigs[systemInfo.defaultInterface]
                    ? originalConfigs[systemInfo.defaultInterface]
                    : defaultNetworkConfig;

            // Determine the best default hostname
            // Use DHCP hostname if static hostname is not set or is localhost
            let defaultHostname = systemInfo.hostname;
            if (!defaultHostname || defaultHostname === "localhost" || defaultHostname === "localhost.localdomain") {
                defaultHostname = systemInfo.dhcpHostname || defaultHostname;
            }

            // Determine the interface type for the default interface
            const defaultInterface = interfaces.find((iface) => iface.Name === systemInfo.defaultInterface);
            const defaultInterfaceType =
                defaultInterface?.Device?.DeviceType === "802-11-wireless" ? "wifi" : "ethernet";

            const defaults = config?.defaults;
            const flightctlConfig = await detectFlightctlConfig();

            const hostnameIsDefault =
                !defaultHostname || defaultHostname === "localhost" || defaultHostname === "localhost.localdomain";
            const resolvedHostname = hostnameIsDefault && defaults?.hostname ? defaults.hostname : defaultHostname;

            const flightctlEndpoint = config?.flightctl?.defaultEndpoint || flightctlConfig.serverUrl || "";

            const connectivityEndpoint = flightctlConfig.serverUrl || flightctlEndpoint;
            let connectivityHost = config?.connectivityTest?.host || "cockpit-project.org";
            if (connectivityEndpoint) {
                try {
                    const url = new URL(connectivityEndpoint);
                    connectivityHost = url.hostname;
                } catch {
                    connectivityHost = connectivityEndpoint;
                }
            }

            setModel((prev) => ({
                ...prev,
                hostname: {
                    value: resolvedHostname,
                    dhcpHostname: systemInfo.dhcpHostname,
                },
                networkInterface: {
                    ...prev.networkInterface,
                    selectedInterface: systemInfo.defaultInterface,
                    interfaceType: systemInfo.defaultInterface ? defaultInterfaceType : null,
                },
                networkAddress: configToState(defaultConfig),
                originalNetworkConfigs: originalConfigs,
                userNetworkConfigs: {},
                networkServices: {
                    ntp: {
                        ...prev.networkServices.ntp,
                        servers: systemInfo.ntpServers,
                        autoConfig: systemInfo.ntpServers.length === 0,
                    },
                    proxy: {
                        ...prev.networkServices.proxy,
                        ...(defaults?.proxy && {
                            enabled: defaults.proxy.enabled ?? prev.networkServices.proxy.enabled,
                            protocol: defaults.proxy.protocol ?? prev.networkServices.proxy.protocol,
                            applyForHttps: defaults.proxy.applyForHttps ?? prev.networkServices.proxy.applyForHttps,
                            hostname: defaults.proxy.hostname ?? prev.networkServices.proxy.hostname,
                            port: defaults.proxy.port ?? prev.networkServices.proxy.port,
                            username: defaults.proxy.username ?? prev.networkServices.proxy.username,
                            password: defaults.proxy.password ?? prev.networkServices.proxy.password,
                            noProxy: defaults.proxy.noProxy ?? prev.networkServices.proxy.noProxy,
                        }),
                    },
                },
                detectedServerUrl: flightctlConfig.serverUrl || "",
                enrollment: patchEnrollment(prev.enrollment, {
                    ...(flightctlConfig.exists && flightctlConfig.hasCredentials && { useExisting: true }),
                    ...(flightctlEndpoint && { endpoint: flightctlEndpoint }),
                }),
                labels: {
                    deviceLabels: defaults?.labels?.deviceLabels ?? prev.labels.deviceLabels,
                    systemInfoMappings: defaults?.labels?.systemInfoMappings ?? prev.labels.systemInfoMappings,
                },
                alias: {
                    mode: resolveDefaultAliasMode(defaults?.alias?.mode ?? prev.alias.mode, resolvedHostname),
                    customValue: defaults?.alias?.customValue ?? prev.alias.customValue,
                },
                connectivityTestHost: connectivityHost,
                connectivityTestRequired: config?.connectivityTest?.required ?? true,
            }));

            setIsInitialized(true);
        } catch (error) {
            console.error("Failed to initialize model from system:", error);
            setIsInitialized(true); // Still mark as initialized even if some parts failed
        }
    };

    useEffect(() => {
        if (networkManager && !isInitialized) {
            // If networkManager exists, attempt initialization regardless of ready state
            // This handles cases where ready might be false or undefined
            if (networkManager.ready) {
                initializeFromSystem();
            } else {
                // If not ready, still mark as initialized to prevent infinite loading
                // The wizard will work with default/empty values
                setIsInitialized(true);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [networkManager, networkManager?.ready, isInitialized]);

    useEffect(() => {
        if (!isInitialized || !previousAttempt) {
            return;
        }

        setModel((prev) => ({
            ...prev,
            hostname: previousAttempt.hostname
                ? {
                      value: previousAttempt.hostname.value,
                      dhcpHostname: previousAttempt.hostname.dhcpHostname || prev.hostname.dhcpHostname || "",
                  }
                : prev.hostname,
            networkInterface: {
                ...prev.networkInterface,
                selectedInterface:
                    previousAttempt.networkInterface?.selectedInterface ?? prev.networkInterface.selectedInterface,
                interfaceType: previousAttempt.networkInterface?.interfaceType ?? prev.networkInterface.interfaceType,
                wifiSsid: previousAttempt.networkInterface?.wifiSsid ?? prev.networkInterface.wifiSsid,
                wifiSecurity: previousAttempt.networkInterface?.wifiSecurity ?? prev.networkInterface.wifiSecurity,
                wifiBand: previousAttempt.networkInterface?.wifiBand ?? prev.networkInterface.wifiBand,
                vlanEnabled:
                    previousAttempt.networkInterface?.vlanEnabled ??
                    (previousAttempt.networkInterface?.vlanId != null ? true : prev.networkInterface.vlanEnabled),
                vlanId: previousAttempt.networkInterface?.vlanId ?? prev.networkInterface.vlanId,
            },
            networkAddress: previousAttempt.networkAddress ?? prev.networkAddress,
            userNetworkConfigs: previousAttempt.userNetworkConfigs ?? prev.userNetworkConfigs,
            networkServices: {
                ntp: previousAttempt.networkServices?.ntp ?? prev.networkServices.ntp,
                proxy: {
                    ...prev.networkServices.proxy,
                    ...(previousAttempt.networkServices?.proxy && {
                        enabled: previousAttempt.networkServices.proxy.enabled,
                        protocol: previousAttempt.networkServices.proxy.protocol,
                        hostname: previousAttempt.networkServices.proxy.hostname,
                        port: previousAttempt.networkServices.proxy.port,
                        noProxy: previousAttempt.networkServices.proxy.noProxy,
                    }),
                },
            },
            enrollment: restoreEnrollmentFromMarker(previousAttempt.enrollment, prev.enrollment),
            alias: previousAttempt.alias ?? prev.alias,
            labels: previousAttempt.labels ?? prev.labels,
            connectivityTestHost: previousAttempt.connectivityTestHost ?? prev.connectivityTestHost,
            connectivityTestRequired: previousAttempt.connectivityTestRequired ?? prev.connectivityTestRequired,
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isInitialized, previousAttempt]);

    useEffect(() => {
        // Cleanup system info service on unmount
        return () => {
            systemConfigurationService.close();
        };
    }, []);

    return (
        <ModelContext.Provider
            value={{
                networkManager,
                model,
                isInitialized,
                updateModel,
                updateNestedModel,
                switchToInterfaceConfig,
                saveCurrentNetworkConfig,
                parseIpv6Address,
                formatIpv6Address,
                cancelEnrollmentRef,
            }}
        >
            {children}
        </ModelContext.Provider>
    );
};

// Hook to use model context
export const useModelContext = () => {
    const context = useContext(ModelContext);
    if (context === undefined) {
        throw new Error("useModelContext must be used within a ModelProvider");
    }
    return context;
};
