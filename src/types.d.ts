/**
 * TypeScript type definitions for Flightctl Onboarding Plugin
 * Derived from data-model.md
 */

import { AliasMode } from "./model-context";

/* eslint-disable no-use-before-define, @typescript-eslint/no-explicit-any */

// ========== Configuration Types (SystemOnboardingConfig) ==========

export interface SystemOnboardingConfig {
    version: string;
    brandName?: string;
    runOnce?: boolean;
    keepCockpit?: boolean;
    hideModules?: boolean;
    autoReboot?: boolean;
    network?: NetworkConfig;
    flightctl?: FlightctlConfig;
    led?: LedConfig;
    defaults?: ConfigDefaults;
    connectivityTest?: ConnectivityTestConfig;
    onboardingUser?: OnboardingUserConfig;
}

export interface ConnectivityTestConfig {
    host?: string;
    carrierTimeoutSeconds?: number;
    connectivityRetries?: number;
    required?: boolean;
}

export interface FlightctlConfig {
    defaultEndpoint?: string;
}

export interface ConfigDefaults {
    hostname?: string;
    proxy?: {
        enabled?: boolean;
        protocol?: ProxyProtocol;
        applyForHttps?: boolean;
        hostname?: string;
        port?: number;
        username?: string;
        password?: string;
        noProxy?: string;
    };
    labels?: {
        deviceLabels?: GenericLabel[];
        systemInfoMappings?: GenericLabel[];
    };
    alias?: {
        mode?: AliasMode;
        customValue?: string;
    };
}

export interface NetworkConfig {
    wifiAp?: WifiApConfig;
    ethernet?: EthernetConfig;
}

export interface WifiApConfig {
    enabled?: boolean;
    ssidPrefix?: string;
    interface?: string;
    password?: string;
    address?: string;
    subnetPrefix?: number;
    dhcpRangeSize?: number;
    channel?: number;
}

export interface EthernetConfig {
    enabled?: boolean;
    interface?: string;
    staticIp?: string;
    subnetPrefix?: number;
    dhcpRangeSize?: number;
}

export interface OnboardingUserConfig {
    password?: string;
}

export interface LedConfig {
    enabled?: boolean;
    tool?: string;
    states?: Record<LedState, string>;
}

export type LedState = "ready" | "in-progress" | "applying" | "success" | "error" | "off";

// ========== Runtime State Types (OnboardingSession) ==========

export interface OnboardingSession {
    hostname: HostnameState;
    networkInterface: NetworkInterfaceState;
    networkAddress: NetworkAddressState;
    networkServices: NetworkServicesState;
    enrollment: ServiceEnrollmentConfig;
    wizardStep: number;
}

export interface HostnameState {
    value: string;
    dhcpHostname?: string;
}

export type WifiSecurity = "none" | "wep" | "wpa";
export type WifiBand = "auto" | "bg" | "a";

export interface NetworkInterfaceState {
    selectedInterface: string | null;
    interfaceType: "ethernet" | "wifi" | null;
    wifiSsid: string | null;
    wifiPassword: string | null;
    wifiSecurity: WifiSecurity | null;
    wifiBand: WifiBand | null;
    vlanEnabled: boolean;
    vlanId: number | null;
}

export interface NetworkAddressState {
    ipv4: IPv4Config;
    ipv6: IPv6Config;
}

export interface IPv4Config {
    method: "auto" | "static" | "disabled";
    address: string | null;
    subnetMask: string | null;
    gateway: string | null;
    autoDns: boolean;
    primaryDns: string | null;
    secondaryDns: string | null;
}

export interface IPv6Config {
    method: "auto" | "dhcp" | "static" | "disabled";
    address: string | null; // with /prefix
    gateway: string | null;
    autoDns: boolean;
    primaryDns: string | null;
    secondaryDns: string | null;
    mayFail: boolean;
}

export interface NetworkServicesState {
    ntp: NtpConfig;
    proxy: ProxyConfig;
}

export interface NtpConfig {
    autoConfig: boolean;
    servers: string[];
}

export type ProxyProtocol = "http" | "https" | "socks5";

export interface ProxyConfig {
    enabled: boolean;
    protocol: ProxyProtocol;
    /** UI-only until backend wiring is reviewed. See NetworkProxySection TODO. */
    applyForHttps: boolean;
    hostname: string | null;
    port: number | null;
    username: string | null;
    password: string | null;
    noProxy: string;
}

export type FlightctlAuthMethod = "token" | "password";

export interface FlightctlTokenCredentials {
    authMethod: "token";
    token: string;
}

export interface FlightctlPasswordCredentials {
    authMethod: "password";
    username: string;
    password: string;
}

export type FlightctlCredentials = FlightctlTokenCredentials | FlightctlPasswordCredentials;

export type TlsMode = "system" | "customCa" | "insecure";
export type AuthCaMode = "system" | "serverCa" | "custom";

export interface ServiceEnrollmentConfig {
    selected: boolean;
    endpoint?: string;
    credentials?: FlightctlCredentials | null;
    useExisting?: boolean;
    tlsMode?: TlsMode;
    caCertPem?: string;
    authCaMode?: AuthCaMode;
    authCaCertPem?: string;
}

export type GenericLabel = { key: string; value: string };

export interface LabelsState {
    deviceLabels: GenericLabel[];
    systemInfoMappings: GenericLabel[];
}

// ========== System Integration Types ==========

export interface NetworkInterface {
    name: string;
    type: "ethernet" | "wifi" | "other";
    macAddress: string;
    state: number;
    ipv4Address: string | null;
    ipv6Address: string | null;
    connection: any | null;
}

export interface WifiNetwork {
    ssid: string;
    strength: number;
    security: WifiSecurity;
    frequency: number;
}

export interface ApplyResult {
    success: boolean;
    results: string[];
    errors?: Error[];
}

// ========== Enrollment Script Result ==========

export interface EnrollmentResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    deviceUrl?: string; // Parsed from stdout "DEVICE_URL: ..."
}
