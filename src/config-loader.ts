/**
 * SPDX-License-Identifier: LGPL-2.1-or-later
 * Configuration loader for Flightctl Onboarding Plugin
 *
 * Implements fallback hierarchy:
 * 1. User override: /etc/cockpit/system-onboarding/config.json (highest priority)
 * 2. Default: /usr/share/cockpit/system-onboarding/config.json (fallback)
 */

import cockpit from "cockpit";
import { SystemOnboardingConfig } from "./types";

// Configuration file paths
const DEFAULT_CONFIG_PATH = "/usr/share/cockpit/system-onboarding/config.json";
const USER_CONFIG_PATH = "/etc/cockpit/system-onboarding/config.json";

// Default configuration if no files are found
export const BUILT_IN_DEFAULTS: SystemOnboardingConfig = {
    version: "1.0",
    brandName: "Flight Control",
    runOnce: true,
    keepCockpit: false,
    hideModules: true,
    autoReboot: false,
    flightctl: {
        defaultEndpoint: "",
        certificateExpiration: "365d",
    },
    network: {
        activationTimeoutSeconds: 30,
        ethernet: {
            enabled: true,
            staticIp: "192.168.100.1",
            subnetPrefix: 24,
            dhcpRangeSize: 40,
            dhcpLeaseDuration: "1h",
            watchdogTimeoutSeconds: 600,
        },
        wifiAp: {
            enabled: false,
            ssidPrefix: "flightctl-",
            interface: "",
            password: "onboarding",
            address: "10.42.0.1",
            subnetPrefix: 24,
            dhcpRangeSize: 40,
            channel: 6,
            dhcpLeaseDuration: "1h",
            watchdogTimeoutSeconds: 420,
            driver: "nl80211",
            hwMode: "g",
            scanWaitMs: 3000,
        },
    },
    onboardingUser: {
        password: "",
    },
    statusHook: {
        enabled: false,
    },
    connectivityTest: {
        host: "cockpit-project.org",
        connectivityTimeoutSeconds: 300,
        required: true,
        ntpSyncTimeoutSeconds: 30,
        pingTimeoutSeconds: 10,
        pingWaitSeconds: 5,
    },
};

/**
 * Load configuration from JSON files with fallback hierarchy
 *
 * @returns Promise<SystemOnboardingConfig> - Loaded and merged configuration
 * @throws Error if configuration is invalid
 */
export async function loadConfig(): Promise<SystemOnboardingConfig> {
    let defaultConfig: Partial<SystemOnboardingConfig> = {};
    let userConfig: Partial<SystemOnboardingConfig> = {};

    // Try to load default configuration
    try {
        const defaultFile = cockpit.file(DEFAULT_CONFIG_PATH, { syntax: JSON });
        const content = await defaultFile.read();
        if (content !== null) {
            defaultConfig = content as Partial<SystemOnboardingConfig>;
        }
    } catch (error) {
        console.warn("Default config not found or could not be read, using built-in defaults:", error);
    }

    // Try to load user override configuration
    try {
        const userFile = cockpit.file(USER_CONFIG_PATH, { syntax: JSON });
        const content = await userFile.read();
        if (content !== null) {
            userConfig = content as Partial<SystemOnboardingConfig>;
        }
    } catch (error) {
        console.info("User config not found, using defaults:", error);
    }

    // Merge configurations: built-in defaults < default file < user override
    const mergedConfig: SystemOnboardingConfig = {
        ...BUILT_IN_DEFAULTS,
        ...defaultConfig,
        ...userConfig,
        // Deep merge for nested objects
        network: {
            ...BUILT_IN_DEFAULTS.network,
            ...defaultConfig.network,
            ...userConfig.network,
            ethernet: {
                ...BUILT_IN_DEFAULTS.network?.ethernet,
                ...defaultConfig.network?.ethernet,
                ...userConfig.network?.ethernet,
            },
            wifiAp: {
                ...BUILT_IN_DEFAULTS.network?.wifiAp,
                ...defaultConfig.network?.wifiAp,
                ...userConfig.network?.wifiAp,
            },
        },
        statusHook: {
            ...BUILT_IN_DEFAULTS.statusHook,
            ...defaultConfig.statusHook,
            ...userConfig.statusHook,
        },
        flightctl: {
            ...BUILT_IN_DEFAULTS.flightctl,
            ...defaultConfig.flightctl,
            ...userConfig.flightctl,
        },
        defaults: {
            ...defaultConfig.defaults,
            ...userConfig.defaults,
            alias: {
                ...defaultConfig.defaults?.alias,
                ...userConfig.defaults?.alias,
            },
            proxy: {
                ...defaultConfig.defaults?.proxy,
                ...userConfig.defaults?.proxy,
            },
            labels: {
                ...defaultConfig.defaults?.labels,
                ...userConfig.defaults?.labels,
            },
            ntp: {
                ...defaultConfig.defaults?.ntp,
                ...userConfig.defaults?.ntp,
            },
            networkAddress: {
                ...defaultConfig.defaults?.networkAddress,
                ...userConfig.defaults?.networkAddress,
                ipv4: {
                    ...defaultConfig.defaults?.networkAddress?.ipv4,
                    ...userConfig.defaults?.networkAddress?.ipv4,
                },
                ipv6: {
                    ...defaultConfig.defaults?.networkAddress?.ipv6,
                    ...userConfig.defaults?.networkAddress?.ipv6,
                },
            },
        },
        connectivityTest: {
            ...BUILT_IN_DEFAULTS.connectivityTest,
            ...defaultConfig.connectivityTest,
            ...userConfig.connectivityTest,
        },
        onboardingUser: {
            ...BUILT_IN_DEFAULTS.onboardingUser,
            ...defaultConfig.onboardingUser,
            ...userConfig.onboardingUser,
        },
    };

    // Validate the merged configuration
    validateConfig(mergedConfig);

    return mergedConfig;
}

/**
 * Validate configuration against schema requirements
 *
 * @param config - Configuration object to validate
 * @throws Error if validation fails
 */
export function validateConfig(config: SystemOnboardingConfig): void {
    // Check required fields
    if (!config.version) {
        throw new Error("Configuration validation failed: version is required");
    }

    if (config.version !== "1.0") {
        throw new Error(`Configuration validation failed: version must be '1.0', got '${config.version}'`);
    }

    if (config.brandName !== undefined) {
        if (typeof config.brandName !== "string") {
            throw new Error("Configuration validation failed: brandName must be a string");
        }

        if (config.brandName.length < 1 || config.brandName.length > 100) {
            throw new Error("Configuration validation failed: brandName length must be between 1 and 100 characters");
        }
    }

    // Validate flightctl configuration if present
    if (config.flightctl?.defaultEndpoint !== undefined) {
        const endpoint = config.flightctl.defaultEndpoint;
        if (typeof endpoint !== "string") {
            throw new Error("flightctl.defaultEndpoint must be a string");
        }
        if (endpoint && !/^https?:\/\//.test(endpoint)) {
            throw new Error("flightctl.defaultEndpoint must start with http:// or https://");
        }
    }

    // Validate top-level boolean fields
    for (const key of ["runOnce", "keepCockpit", "hideModules", "autoReboot"] as const) {
        if (config[key] !== undefined && typeof config[key] !== "boolean") {
            throw new Error(`${key} must be a boolean`);
        }
    }

    // Validate network configuration
    if (config.network) {
        if (config.network.ethernet?.enabled !== undefined && typeof config.network.ethernet.enabled !== "boolean") {
            throw new Error("network.ethernet.enabled must be a boolean");
        }

        if (config.network.ethernet?.interface !== undefined && config.network.ethernet.interface !== "") {
            if (typeof config.network.ethernet.interface !== "string" || config.network.ethernet.interface.length > 15) {
                throw new Error("Ethernet interface must be a string of at most 15 characters");
            }
            if (!/^[a-zA-Z0-9._-]+$/.test(config.network.ethernet.interface)) {
                throw new Error("Ethernet interface must contain only alphanumeric characters, dots, underscores, and hyphens");
            }
        }

        if (config.network.wifiAp?.enabled !== undefined && typeof config.network.wifiAp.enabled !== "boolean") {
            throw new Error("network.wifiAp.enabled must be a boolean");
        }

        if (config.network.wifiAp) {
            const wifiAp = config.network.wifiAp;

            if (wifiAp.ssidPrefix !== undefined) {
                if (
                    typeof wifiAp.ssidPrefix !== "string" ||
                    wifiAp.ssidPrefix.length < 1 ||
                    wifiAp.ssidPrefix.length > 20
                ) {
                    throw new Error("WiFi AP ssidPrefix must be a string between 1 and 20 characters");
                }

                if (!/^[a-zA-Z0-9_-]+$/.test(wifiAp.ssidPrefix)) {
                    throw new Error(
                        "WiFi AP ssidPrefix must contain only alphanumeric characters, underscores, and hyphens"
                    );
                }
            }

            if (wifiAp.interface !== undefined && wifiAp.interface !== "") {
                if (typeof wifiAp.interface !== "string" || wifiAp.interface.length > 15) {
                    throw new Error("WiFi AP interface must be a string of at most 15 characters");
                }
                if (!/^[a-zA-Z0-9._-]+$/.test(wifiAp.interface)) {
                    throw new Error(
                        "WiFi AP interface must contain only alphanumeric characters, dots, underscores, and hyphens"
                    );
                }
            }

            if (wifiAp.password !== undefined) {
                if (typeof wifiAp.password !== "string") {
                    throw new Error("WiFi AP password must be a string");
                }
                // Empty string means open network (no password); non-empty must be 8-63 chars (WPA2 requirement)
                if (wifiAp.password.length > 0 && (wifiAp.password.length < 8 || wifiAp.password.length > 63)) {
                    throw new Error("WiFi AP password must be empty (open network) or between 8 and 63 characters");
                }
            }
        }

        if (config.network.ethernet?.staticIp !== undefined) {
            const staticIp = config.network.ethernet.staticIp;
            if (typeof staticIp !== "string" || !isValidIPv4(staticIp)) {
                throw new Error(`Ethernet staticIp must be a valid IPv4 address, got '${staticIp}'`);
            }
        }

        if (config.network.ethernet?.subnetPrefix !== undefined) {
            const prefix = config.network.ethernet.subnetPrefix;
            if (typeof prefix !== "number" || prefix < 1 || prefix > 30) {
                throw new Error("Ethernet subnetPrefix must be a number between 1 and 30");
            }
        }

        if (config.network.ethernet?.dhcpRangeSize !== undefined) {
            const size = config.network.ethernet.dhcpRangeSize;
            if (typeof size !== "number" || size <= 0) {
                throw new Error("Ethernet dhcpRangeSize must be a number greater than 0");
            }
        }

        if (config.network.wifiAp?.address !== undefined) {
            const addr = config.network.wifiAp.address;
            if (typeof addr !== "string" || !isValidIPv4(addr)) {
                throw new Error(`WiFi AP address must be a valid IPv4 address, got '${addr}'`);
            }
        }

        if (config.network.wifiAp?.subnetPrefix !== undefined) {
            const prefix = config.network.wifiAp.subnetPrefix;
            if (typeof prefix !== "number" || prefix < 1 || prefix > 30) {
                throw new Error("WiFi AP subnetPrefix must be a number between 1 and 30");
            }
        }

        if (config.network.wifiAp?.dhcpRangeSize !== undefined) {
            const size = config.network.wifiAp.dhcpRangeSize;
            if (typeof size !== "number" || size <= 0) {
                throw new Error("WiFi AP dhcpRangeSize must be a number greater than 0");
            }
        }

        if (config.network.wifiAp?.channel !== undefined) {
            const ch = config.network.wifiAp.channel;
            if (typeof ch !== "number" || ch < 1 || ch > 14) {
                throw new Error("WiFi AP channel must be a number between 1 and 14");
            }
        }

        if (config.network.wifiAp?.dhcpLeaseDuration !== undefined) {
            if (typeof config.network.wifiAp.dhcpLeaseDuration !== "string" ||
                !/^\d+[smhd]$/.test(config.network.wifiAp.dhcpLeaseDuration)) {
                throw new Error("WiFi AP dhcpLeaseDuration must be a duration string (e.g. '1h', '30m', '3600s')");
            }
        }

        if (config.network.wifiAp?.watchdogTimeoutSeconds !== undefined) {
            const val = config.network.wifiAp.watchdogTimeoutSeconds;
            if (typeof val !== "number" || val < 60 || val > 1800) {
                throw new Error("WiFi AP watchdogTimeoutSeconds must be a number between 60 and 1800");
            }
        }

        if (config.network.wifiAp?.driver !== undefined) {
            if (typeof config.network.wifiAp.driver !== "string" || config.network.wifiAp.driver.length < 1) {
                throw new Error("WiFi AP driver must be a non-empty string");
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(config.network.wifiAp.driver)) {
                throw new Error("WiFi AP driver must contain only alphanumeric characters, underscores, and hyphens");
            }
        }

        if (config.network.wifiAp?.hwMode !== undefined) {
            const valid = ["a", "b", "g", "ad"];
            if (!valid.includes(config.network.wifiAp.hwMode)) {
                throw new Error(`WiFi AP hwMode must be one of: ${valid.join(", ")}`);
            }
        }

        if (config.network.wifiAp?.scanWaitMs !== undefined) {
            const val = config.network.wifiAp.scanWaitMs;
            if (typeof val !== "number" || val <= 0) {
                throw new Error("WiFi AP scanWaitMs must be a number greater than 0");
            }
        }

        if (config.network.ethernet?.dhcpLeaseDuration !== undefined) {
            if (typeof config.network.ethernet.dhcpLeaseDuration !== "string" ||
                !/^\d+[smhd]$/.test(config.network.ethernet.dhcpLeaseDuration)) {
                throw new Error("Ethernet dhcpLeaseDuration must be a duration string (e.g. '1h', '30m', '3600s')");
            }
        }

        if (config.network.ethernet?.watchdogTimeoutSeconds !== undefined) {
            const val = config.network.ethernet.watchdogTimeoutSeconds;
            if (typeof val !== "number" || val < 60 || val > 1800) {
                throw new Error("Ethernet watchdogTimeoutSeconds must be a number between 60 and 1800");
            }
        }

        if (config.network.activationTimeoutSeconds !== undefined) {
            const val = config.network.activationTimeoutSeconds;
            if (typeof val !== "number" || val <= 0) {
                throw new Error("network.activationTimeoutSeconds must be a number greater than 0");
            }
        }

    }

    if (config.onboardingUser?.password !== undefined) {
        if (typeof config.onboardingUser.password !== "string") {
            throw new Error("onboardingUser.password must be a string");
        }
    }

    // Validate connectivity test configuration
    if (config.connectivityTest?.host !== undefined) {
        const val = config.connectivityTest.host;
        if (typeof val !== "string" || !/^[a-zA-Z0-9.:-]+$/.test(val)) {
            throw new Error("connectivityTest.host must be a valid hostname or IP address");
        }
    }

    if (config.connectivityTest?.required !== undefined) {
        if (typeof config.connectivityTest.required !== "boolean") {
            throw new Error("connectivityTest.required must be a boolean");
        }
    }

    if (config.connectivityTest?.connectivityTimeoutSeconds !== undefined) {
        const val = config.connectivityTest.connectivityTimeoutSeconds;
        if (typeof val !== "number" || val <= 0) {
            throw new Error("connectivityTest.connectivityTimeoutSeconds must be a number greater than 0");
        }
    }

    if (config.connectivityTest?.ntpSyncTimeoutSeconds !== undefined) {
        const val = config.connectivityTest.ntpSyncTimeoutSeconds;
        if (typeof val !== "number" || val <= 0) {
            throw new Error("connectivityTest.ntpSyncTimeoutSeconds must be a number greater than 0");
        }
    }

    if (config.connectivityTest?.pingTimeoutSeconds !== undefined) {
        const val = config.connectivityTest.pingTimeoutSeconds;
        if (typeof val !== "number" || val <= 0) {
            throw new Error("connectivityTest.pingTimeoutSeconds must be a number greater than 0");
        }
    }

    if (config.connectivityTest?.pingWaitSeconds !== undefined) {
        const val = config.connectivityTest.pingWaitSeconds;
        if (typeof val !== "number" || val <= 0) {
            throw new Error("connectivityTest.pingWaitSeconds must be a number greater than 0");
        }
    }

    // Validate flightctl configuration
    if (config.flightctl?.certificateExpiration !== undefined) {
        if (typeof config.flightctl.certificateExpiration !== "string" ||
            !/^\d+[dhm]$/.test(config.flightctl.certificateExpiration)) {
            throw new Error("flightctl.certificateExpiration must be a duration string (e.g. '365d', '24h', '60m')");
        }
    }

    // Validate defaults
    if (config.defaults?.ntp?.servers !== undefined) {
        if (!Array.isArray(config.defaults.ntp.servers)) {
            throw new Error("defaults.ntp.servers must be an array of strings");
        }
    }

    if (config.defaults?.networkAddress?.ipv4) {
        const ipv4 = config.defaults.networkAddress.ipv4;
        if (ipv4.method !== undefined) {
            const valid = ["auto", "static", "disabled"];
            if (!valid.includes(ipv4.method)) {
                throw new Error(`defaults.networkAddress.ipv4.method must be one of: ${valid.join(", ")}`);
            }
        }
        if (ipv4.address !== undefined && !isValidIPv4(ipv4.address)) {
            throw new Error("defaults.networkAddress.ipv4.address must be a valid IPv4 address");
        }
        if (ipv4.subnetMask !== undefined && !isValidIPv4(ipv4.subnetMask)) {
            throw new Error("defaults.networkAddress.ipv4.subnetMask must be a valid IPv4 address");
        }
        if (ipv4.gateway !== undefined && !isValidIPv4(ipv4.gateway)) {
            throw new Error("defaults.networkAddress.ipv4.gateway must be a valid IPv4 address");
        }
    }

    if (config.defaults?.networkAddress?.ipv6) {
        const ipv6 = config.defaults.networkAddress.ipv6;
        if (ipv6.method !== undefined) {
            const valid = ["auto", "dhcp", "static", "disabled"];
            if (!valid.includes(ipv6.method)) {
                throw new Error(`defaults.networkAddress.ipv6.method must be one of: ${valid.join(", ")}`);
            }
        }
    }

    // Validate status hook configuration
    if (config.statusHook?.enabled === true) {
        if (!config.statusHook.tool || typeof config.statusHook.tool !== "string") {
            throw new Error("statusHook: tool is required when statusHook is enabled");
        }
        if (config.statusHook.tool.includes("/") || config.statusHook.tool.includes("..")) {
            throw new Error("statusHook: tool must be a filename only (no path separators or '..')");
        }
    }
}

/**
 * Validate IPv4 address format
 *
 * @param ip - IP address string to validate
 * @returns boolean - true if valid IPv4 address
 */
function isValidIPv4(ip: string): boolean {
    const parts = ip.split(".");
    if (parts.length !== 4) {
        return false;
    }

    return parts.every((part) => {
        const num = parseInt(part, 10);
        return !isNaN(num) && num >= 0 && num <= 255 && part === String(num);
    });
}

// Re-export the interface for convenience
export type { SystemOnboardingConfig };
