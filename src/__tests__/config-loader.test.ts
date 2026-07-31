/* SPDX-License-Identifier: LGPL-2.1-or-later */
import cockpit from "cockpit";
import { SystemOnboardingConfig } from "../types";
import { validateConfig, loadConfig } from "../config-loader";

const makeValidConfig = (overrides: Partial<SystemOnboardingConfig> = {}): SystemOnboardingConfig => ({
    version: "1.0",
    ...overrides,
});

describe("validateConfig", () => {
    describe("version", () => {
        test("accepts version 1.0", () => {
            expect(() => validateConfig(makeValidConfig())).not.toThrow();
        });

        test("rejects missing version", () => {
            expect(() => validateConfig({ version: "" } as SystemOnboardingConfig)).toThrow("version is required");
        });

        test("rejects wrong version", () => {
            expect(() => validateConfig(makeValidConfig({ version: "2.0" }))).toThrow("version must be '1.0'");
        });
    });

    describe("brandName", () => {
        test("accepts valid brand name", () => {
            expect(() => validateConfig(makeValidConfig({ brandName: "My Brand" }))).not.toThrow();
        });

        test("rejects non-string brand name", () => {
            expect(() => validateConfig(makeValidConfig({ brandName: 42 as unknown as string }))).toThrow(
                "brandName must be a string"
            );
        });

        test("rejects empty brand name", () => {
            expect(() => validateConfig(makeValidConfig({ brandName: "" }))).toThrow(
                "brandName length must be between 1 and 100"
            );
        });

        test("rejects brand name over 100 chars", () => {
            expect(() => validateConfig(makeValidConfig({ brandName: "x".repeat(101) }))).toThrow(
                "brandName length must be between 1 and 100"
            );
        });
    });

    describe("WiFi AP new fields", () => {
        const makeWifiConfig = (wifiOverrides: Record<string, unknown>) =>
            makeValidConfig({ network: { wifiAp: { ...wifiOverrides } } });

        describe("dhcpLeaseDuration", () => {
            const validCases: [string, string][] = [
                ["seconds", "3600s"],
                ["minutes", "30m"],
                ["hours", "1h"],
                ["days", "7d"],
            ];

            test.each(validCases)("accepts %s duration (%s)", (_name, value) => {
                expect(() => validateConfig(makeWifiConfig({ dhcpLeaseDuration: value }))).not.toThrow();
            });

            const invalidCases: [string, unknown][] = [
                ["number instead of string", 3600],
                ["missing unit", "3600"],
                ["invalid unit", "1x"],
                ["empty string", ""],
                ["no digits", "h"],
            ];

            test.each(invalidCases)("rejects %s (%s)", (_name, value) => {
                expect(() => validateConfig(makeWifiConfig({ dhcpLeaseDuration: value }))).toThrow(
                    "WiFi AP dhcpLeaseDuration"
                );
            });
        });

        describe("watchdogTimeoutSeconds", () => {
            test("accepts minimum (60)", () => {
                expect(() => validateConfig(makeWifiConfig({ watchdogTimeoutSeconds: 60 }))).not.toThrow();
            });

            test("accepts maximum (1800)", () => {
                expect(() => validateConfig(makeWifiConfig({ watchdogTimeoutSeconds: 1800 }))).not.toThrow();
            });

            test("rejects below minimum", () => {
                expect(() => validateConfig(makeWifiConfig({ watchdogTimeoutSeconds: 59 }))).toThrow(
                    "WiFi AP watchdogTimeoutSeconds must be a number between 60 and 1800"
                );
            });

            test("rejects above maximum", () => {
                expect(() => validateConfig(makeWifiConfig({ watchdogTimeoutSeconds: 1801 }))).toThrow(
                    "WiFi AP watchdogTimeoutSeconds must be a number between 60 and 1800"
                );
            });

            test("rejects non-number", () => {
                expect(() => validateConfig(makeWifiConfig({ watchdogTimeoutSeconds: "240" }))).toThrow(
                    "WiFi AP watchdogTimeoutSeconds"
                );
            });
        });

        describe("driver", () => {
            test("accepts valid driver", () => {
                expect(() => validateConfig(makeWifiConfig({ driver: "nl80211" }))).not.toThrow();
            });

            test("rejects empty string", () => {
                expect(() => validateConfig(makeWifiConfig({ driver: "" }))).toThrow(
                    "WiFi AP driver must be a non-empty string"
                );
            });

            test("rejects non-string", () => {
                expect(() => validateConfig(makeWifiConfig({ driver: 42 }))).toThrow(
                    "WiFi AP driver must be a non-empty string"
                );
            });
        });

        describe("hwMode", () => {
            const validModes: [string, string][] = [
                ["2.4 GHz", "g"],
                ["5 GHz", "a"],
                ["legacy", "b"],
                ["60 GHz", "ad"],
            ];

            test.each(validModes)("accepts %s mode (%s)", (_name, mode) => {
                expect(() => validateConfig(makeWifiConfig({ hwMode: mode }))).not.toThrow();
            });

            test("rejects invalid mode", () => {
                expect(() => validateConfig(makeWifiConfig({ hwMode: "n" }))).toThrow("WiFi AP hwMode must be one of");
            });
        });

        describe("scanWaitMs", () => {
            test("accepts positive value", () => {
                expect(() => validateConfig(makeWifiConfig({ scanWaitMs: 5000 }))).not.toThrow();
            });

            test("rejects zero", () => {
                expect(() => validateConfig(makeWifiConfig({ scanWaitMs: 0 }))).toThrow(
                    "WiFi AP scanWaitMs must be a number greater than 0"
                );
            });

            test("rejects negative", () => {
                expect(() => validateConfig(makeWifiConfig({ scanWaitMs: -1 }))).toThrow(
                    "WiFi AP scanWaitMs must be a number greater than 0"
                );
            });
        });
    });

    describe("Ethernet new fields", () => {
        const makeEthConfig = (ethOverrides: Record<string, unknown>) =>
            makeValidConfig({ network: { ethernet: { ...ethOverrides } } });

        describe("dhcpLeaseDuration", () => {
            test("accepts valid duration", () => {
                expect(() => validateConfig(makeEthConfig({ dhcpLeaseDuration: "2h" }))).not.toThrow();
            });

            test("rejects invalid duration", () => {
                expect(() => validateConfig(makeEthConfig({ dhcpLeaseDuration: "forever" }))).toThrow(
                    "Ethernet dhcpLeaseDuration"
                );
            });
        });

        describe("watchdogTimeoutSeconds", () => {
            test("accepts valid value", () => {
                expect(() => validateConfig(makeEthConfig({ watchdogTimeoutSeconds: 600 }))).not.toThrow();
            });

            test("rejects below minimum", () => {
                expect(() => validateConfig(makeEthConfig({ watchdogTimeoutSeconds: 30 }))).toThrow(
                    "Ethernet watchdogTimeoutSeconds must be a number between 60 and 1800"
                );
            });
        });
    });

    describe("network top-level fields", () => {
        describe("activationTimeoutSeconds", () => {
            test("accepts positive value", () => {
                expect(() =>
                    validateConfig(makeValidConfig({ network: { activationTimeoutSeconds: 60 } }))
                ).not.toThrow();
            });

            test("rejects zero", () => {
                expect(() =>
                    validateConfig(makeValidConfig({ network: { activationTimeoutSeconds: 0 } }))
                ).toThrow("network.activationTimeoutSeconds must be a number greater than 0");
            });
        });

    });

    describe("connectivityTest new fields", () => {
        const makeConnConfig = (overrides: Record<string, unknown>) =>
            makeValidConfig({ connectivityTest: { ...overrides } });

        const positiveNumberFields: [string, string][] = [
            ["ntpSyncTimeoutSeconds", "connectivityTest.ntpSyncTimeoutSeconds"],
            ["pingTimeoutSeconds", "connectivityTest.pingTimeoutSeconds"],
            ["pingWaitSeconds", "connectivityTest.pingWaitSeconds"],
        ];

        test.each(positiveNumberFields)("%s accepts positive value", (field) => {
            expect(() => validateConfig(makeConnConfig({ [field]: 30 }))).not.toThrow();
        });

        test.each(positiveNumberFields)("%s rejects zero", (field, errorKey) => {
            expect(() => validateConfig(makeConnConfig({ [field]: 0 }))).toThrow(
                `${errorKey} must be a number greater than 0`
            );
        });

        test.each(positiveNumberFields)("%s rejects non-number", (field, errorKey) => {
            expect(() => validateConfig(makeConnConfig({ [field]: "30" }))).toThrow(
                `${errorKey} must be a number greater than 0`
            );
        });
    });

    describe("flightctl.certificateExpiration", () => {
        const validCases: [string, string][] = [
            ["days", "365d"],
            ["hours", "24h"],
            ["minutes", "60m"],
        ];

        test.each(validCases)("accepts %s format (%s)", (_name, value) => {
            expect(() => validateConfig(makeValidConfig({ flightctl: { certificateExpiration: value } }))).not.toThrow();
        });

        const invalidCases: [string, unknown][] = [
            ["seconds (not allowed)", "3600s"],
            ["no unit", "365"],
            ["number type", 365],
            ["empty string", ""],
        ];

        test.each(invalidCases)("rejects %s (%s)", (_name, value) => {
            expect(() =>
                validateConfig(
                    makeValidConfig({ flightctl: { certificateExpiration: value as string } })
                )
            ).toThrow("flightctl.certificateExpiration must be a duration string");
        });
    });

    describe("defaults validation", () => {
        describe("ntp.servers", () => {
            test("accepts array", () => {
                expect(() =>
                    validateConfig(makeValidConfig({ defaults: { ntp: { servers: ["ntp1.example.com"] } } }))
                ).not.toThrow();
            });

            test("accepts empty array", () => {
                expect(() =>
                    validateConfig(makeValidConfig({ defaults: { ntp: { servers: [] } } }))
                ).not.toThrow();
            });

            test("rejects non-array", () => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({
                            defaults: { ntp: { servers: "ntp1.example.com" as unknown as string[] } },
                        })
                    )
                ).toThrow("defaults.ntp.servers must be an array");
            });
        });

        describe("networkAddress.ipv4", () => {
            test("accepts valid method", () => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({ defaults: { networkAddress: { ipv4: { method: "static" } } } })
                    )
                ).not.toThrow();
            });

            const validMethods: [string][] = [["auto"], ["static"], ["disabled"]];
            test.each(validMethods)("accepts method %s", (method) => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({
                            defaults: {
                                networkAddress: {
                                    ipv4: { method: method as "auto" | "static" | "disabled" },
                                },
                            },
                        })
                    )
                ).not.toThrow();
            });

            test("rejects invalid method", () => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({
                            defaults: {
                                networkAddress: {
                                    ipv4: { method: "dhcp" as "auto" },
                                },
                            },
                        })
                    )
                ).toThrow("defaults.networkAddress.ipv4.method must be one of");
            });

            test("accepts valid IPv4 address", () => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({
                            defaults: { networkAddress: { ipv4: { address: "10.0.0.1" } } },
                        })
                    )
                ).not.toThrow();
            });

            test("rejects invalid IPv4 address", () => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({
                            defaults: { networkAddress: { ipv4: { address: "999.999.999.999" } } },
                        })
                    )
                ).toThrow("defaults.networkAddress.ipv4.address must be a valid IPv4");
            });

            test("validates subnetMask as IPv4", () => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({
                            defaults: { networkAddress: { ipv4: { subnetMask: "not-an-ip" } } },
                        })
                    )
                ).toThrow("defaults.networkAddress.ipv4.subnetMask must be a valid IPv4");
            });

            test("validates gateway as IPv4", () => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({
                            defaults: { networkAddress: { ipv4: { gateway: "abc" } } },
                        })
                    )
                ).toThrow("defaults.networkAddress.ipv4.gateway must be a valid IPv4");
            });
        });

        describe("networkAddress.ipv6", () => {
            const validMethods: [string][] = [["auto"], ["dhcp"], ["static"], ["disabled"]];
            test.each(validMethods)("accepts method %s", (method) => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({
                            defaults: {
                                networkAddress: {
                                    ipv6: { method: method as "auto" | "dhcp" | "static" | "disabled" },
                                },
                            },
                        })
                    )
                ).not.toThrow();
            });

            test("rejects invalid method", () => {
                expect(() =>
                    validateConfig(
                        makeValidConfig({
                            defaults: {
                                networkAddress: {
                                    ipv6: { method: "manual" as "auto" },
                                },
                            },
                        })
                    )
                ).toThrow("defaults.networkAddress.ipv6.method must be one of");
            });
        });
    });

    describe("statusHook validation", () => {
        test("accepts enabled with tool", () => {
            expect(() =>
                validateConfig(makeValidConfig({ statusHook: { enabled: true, tool: "my-hook" } }))
            ).not.toThrow();
        });

        test("rejects enabled without tool", () => {
            expect(() => validateConfig(makeValidConfig({ statusHook: { enabled: true } }))).toThrow(
                "tool is required when statusHook is enabled"
            );
        });

        test("accepts disabled without tool", () => {
            expect(() => validateConfig(makeValidConfig({ statusHook: { enabled: false } }))).not.toThrow();
        });

        test("rejects enabled with empty tool", () => {
            expect(() =>
                validateConfig(makeValidConfig({ statusHook: { enabled: true, tool: "" } }))
            ).toThrow("tool is required when statusHook is enabled");
        });

        test("rejects tool with slash", () => {
            expect(() =>
                validateConfig(makeValidConfig({ statusHook: { enabled: true, tool: "sub/path" } }))
            ).toThrow("tool must be a filename only");
        });

        test("rejects tool with dot-dot", () => {
            expect(() =>
                validateConfig(makeValidConfig({ statusHook: { enabled: true, tool: "..evil" } }))
            ).toThrow("tool must be a filename only");
        });
    });
});

describe("loadConfig", () => {
    const mockFileRead = (content: unknown) => ({
        path: "/mock/path",
        read: jest.fn(() => Promise.resolve(content)),
        replace: jest.fn(),
        modify: jest.fn(),
        watch: jest.fn(() => ({ remove: jest.fn() })),
        close: jest.fn(),
    });

    beforeEach(() => {
        jest.mocked(cockpit.file).mockReset();
    });

    test("returns built-in defaults when both files are empty", async () => {
        jest.mocked(cockpit.file).mockReturnValue(mockFileRead(null) as ReturnType<typeof cockpit.file>);

        const config = await loadConfig();

        expect(config.version).toBe("1.0");
        expect(config.brandName).toBe("Flight Control");
        expect(config.network?.activationTimeoutSeconds).toBe(30);
        expect(config.network?.wifiAp?.dhcpLeaseDuration).toBe("1h");
        expect(config.network?.wifiAp?.watchdogTimeoutSeconds).toBe(420);
        expect(config.network?.wifiAp?.driver).toBe("nl80211");
        expect(config.network?.wifiAp?.hwMode).toBe("g");
        expect(config.network?.wifiAp?.scanWaitMs).toBe(3000);
        expect(config.network?.ethernet?.dhcpLeaseDuration).toBe("1h");
        expect(config.network?.ethernet?.watchdogTimeoutSeconds).toBe(600);
        expect(config.connectivityTest?.ntpSyncTimeoutSeconds).toBe(30);
        expect(config.connectivityTest?.pingTimeoutSeconds).toBe(10);
        expect(config.connectivityTest?.pingWaitSeconds).toBe(5);
        expect(config.flightctl?.certificateExpiration).toBe("365d");
    });

    test("user override merges over package defaults for top-level fields", async () => {
        jest.mocked(cockpit.file)
            .mockReturnValueOnce(mockFileRead({ version: "1.0", brandName: "Default Brand" }) as ReturnType<typeof cockpit.file>)
            .mockReturnValueOnce(mockFileRead({ brandName: "Custom Brand" }) as ReturnType<typeof cockpit.file>);

        const config = await loadConfig();

        expect(config.brandName).toBe("Custom Brand");
    });

    test("deep merge for wifiAp — override one field doesn't clobber siblings", async () => {
        const defaultCfg = {
            version: "1.0",
            network: {
                wifiAp: { dhcpLeaseDuration: "2h", driver: "nl80211", hwMode: "g" },
            },
        };
        const userCfg = {
            network: { wifiAp: { dhcpLeaseDuration: "30m" } },
        };

        jest.mocked(cockpit.file)
            .mockReturnValueOnce(mockFileRead(defaultCfg) as ReturnType<typeof cockpit.file>)
            .mockReturnValueOnce(mockFileRead(userCfg) as ReturnType<typeof cockpit.file>);

        const config = await loadConfig();

        expect(config.network?.wifiAp?.dhcpLeaseDuration).toBe("30m");
        expect(config.network?.wifiAp?.driver).toBe("nl80211");
        expect(config.network?.wifiAp?.hwMode).toBe("g");
    });

    test("deep merge for defaults.ntp", async () => {
        const defaultCfg = {
            version: "1.0",
            defaults: { ntp: { autoConfig: true, servers: ["pool.ntp.org"] } },
        };
        const userCfg = {
            defaults: { ntp: { servers: ["ntp1.corp.com", "ntp2.corp.com"] } },
        };

        jest.mocked(cockpit.file)
            .mockReturnValueOnce(mockFileRead(defaultCfg) as ReturnType<typeof cockpit.file>)
            .mockReturnValueOnce(mockFileRead(userCfg) as ReturnType<typeof cockpit.file>);

        const config = await loadConfig();

        expect(config.defaults?.ntp?.servers).toEqual(["ntp1.corp.com", "ntp2.corp.com"]);
        expect(config.defaults?.ntp?.autoConfig).toBe(true);
    });

    test("deep merge for defaults.networkAddress.ipv4 — partial override", async () => {
        const defaultCfg = {
            version: "1.0",
            defaults: {
                networkAddress: {
                    ipv4: { method: "static" as const, address: "10.0.0.1", gateway: "10.0.0.254" },
                },
            },
        };
        const userCfg = {
            defaults: {
                networkAddress: { ipv4: { address: "192.168.1.100" } },
            },
        };

        jest.mocked(cockpit.file)
            .mockReturnValueOnce(mockFileRead(defaultCfg) as ReturnType<typeof cockpit.file>)
            .mockReturnValueOnce(mockFileRead(userCfg) as ReturnType<typeof cockpit.file>);

        const config = await loadConfig();

        expect(config.defaults?.networkAddress?.ipv4?.address).toBe("192.168.1.100");
        expect(config.defaults?.networkAddress?.ipv4?.method).toBe("static");
        expect(config.defaults?.networkAddress?.ipv4?.gateway).toBe("10.0.0.254");
    });

    test("deep merge for defaults.networkAddress.ipv6 — partial override", async () => {
        const defaultCfg = {
            version: "1.0",
            defaults: {
                networkAddress: {
                    ipv6: { method: "auto" as const, gateway: "fe80::1" },
                },
            },
        };
        const userCfg = {
            defaults: {
                networkAddress: { ipv6: { method: "static" as const } },
            },
        };

        jest.mocked(cockpit.file)
            .mockReturnValueOnce(mockFileRead(defaultCfg) as ReturnType<typeof cockpit.file>)
            .mockReturnValueOnce(mockFileRead(userCfg) as ReturnType<typeof cockpit.file>);

        const config = await loadConfig();

        expect(config.defaults?.networkAddress?.ipv6?.method).toBe("static");
        expect(config.defaults?.networkAddress?.ipv6?.gateway).toBe("fe80::1");
    });

    test("deep merge for defaults.proxy — user override merges over package defaults", async () => {
        const defaultCfg = {
            version: "1.0",
            defaults: {
                proxy: { noProxy: "10.0.0.0/8", enabled: true },
            },
        };
        const userCfg = {
            defaults: {
                proxy: { noProxy: "10.0.0.0/8,172.16.0.0/12" },
            },
        };

        jest.mocked(cockpit.file)
            .mockReturnValueOnce(mockFileRead(defaultCfg) as ReturnType<typeof cockpit.file>)
            .mockReturnValueOnce(mockFileRead(userCfg) as ReturnType<typeof cockpit.file>);

        const config = await loadConfig();

        expect(config.defaults?.proxy?.noProxy).toBe("10.0.0.0/8,172.16.0.0/12");
        expect(config.defaults?.proxy?.enabled).toBe(true);
    });

    test("connectivityTest fields merge from all three layers", async () => {
        const defaultCfg = {
            version: "1.0",
            connectivityTest: { ntpSyncTimeoutSeconds: 45 },
        };
        const userCfg = {
            connectivityTest: { pingTimeoutSeconds: 15 },
        };

        jest.mocked(cockpit.file)
            .mockReturnValueOnce(mockFileRead(defaultCfg) as ReturnType<typeof cockpit.file>)
            .mockReturnValueOnce(mockFileRead(userCfg) as ReturnType<typeof cockpit.file>);

        const config = await loadConfig();

        expect(config.connectivityTest?.ntpSyncTimeoutSeconds).toBe(45);
        expect(config.connectivityTest?.pingTimeoutSeconds).toBe(15);
        expect(config.connectivityTest?.pingWaitSeconds).toBe(5);
    });
});
