import { IPv4Config, IPv6Config } from "../types";
import { validateURL, validateSystemHostname, validateDns, validateIpv4DnsConfig, validateIpv6DnsConfig } from "../validation";

describe("validateDns", () => {
    const validCases: [string, string, "ipv4" | "ipv6"][] = [
        ["IPv4 address in IPv4 context", "8.8.8.8", "ipv4"],
        ["IPv4 address in IPv4 context (alt)", "192.168.1.1", "ipv4"],
        ["IPv6 address in IPv6 context", "2001:4860:4860::8888", "ipv6"],
        ["IPv6 address in IPv6 context (loopback)", "::1", "ipv6"],
    ];

    test.each(validCases)("accepts %s", (_name, ip, version) => {
        expect(validateDns(ip, version)).toBeNull();
    });

    const rejectedCases: [string, string, "ipv4" | "ipv6"][] = [
        ["IPv6 address in IPv4 context", "2001:4860:4860::8888", "ipv4"],
        ["IPv6 loopback in IPv4 context", "::1", "ipv4"],
        ["IPv4 address in IPv6 context", "8.8.8.8", "ipv6"],
        ["IPv4 address in IPv6 context (alt)", "192.168.1.1", "ipv6"],
    ];

    test.each(rejectedCases)("rejects %s", (_name, ip, version) => {
        expect(validateDns(ip, version)).not.toBeNull();
    });

    test("returns error when required and empty", () => {
        expect(validateDns("", "ipv4", true)).toBe("DNS server address is required");
        expect(validateDns("", "ipv6", true)).toBe("DNS server address is required");
    });

    test("returns null when optional and empty", () => {
        expect(validateDns("", "ipv4", false)).toBeNull();
        expect(validateDns("", "ipv6", false)).toBeNull();
    });
});

describe("validateIpv4DnsConfig", () => {
    const makeIpv4Config = (overrides: Partial<IPv4Config> = {}): IPv4Config => ({
        method: "static",
        address: "192.168.1.10",
        subnetMask: "255.255.255.0",
        gateway: "192.168.1.1",
        autoDns: false,
        primaryDns: null,
        secondaryDns: null,
        ...overrides,
    });

    test("accepts valid IPv4 DNS", () => {
        expect(validateIpv4DnsConfig(makeIpv4Config({ primaryDns: "8.8.8.8" }))).toBe(true);
    });

    test("accepts valid IPv4 DNS with secondary", () => {
        expect(validateIpv4DnsConfig(makeIpv4Config({ primaryDns: "8.8.8.8", secondaryDns: "8.8.4.4" }))).toBe(true);
    });

    test("rejects IPv6 address as IPv4 DNS", () => {
        expect(validateIpv4DnsConfig(makeIpv4Config({ primaryDns: "2001:4860:4860::8888" }))).toBe(false);
    });

    test("rejects IPv6 secondary DNS in IPv4 config", () => {
        expect(
            validateIpv4DnsConfig(makeIpv4Config({ primaryDns: "8.8.8.8", secondaryDns: "2001:4860:4860::8844" })),
        ).toBe(false);
    });

    test("accepts autoDns without DNS addresses", () => {
        expect(validateIpv4DnsConfig(makeIpv4Config({ autoDns: true }))).toBe(true);
    });
});

describe("validateIpv6DnsConfig", () => {
    const makeIpv6Config = (overrides: Partial<IPv6Config> = {}): IPv6Config => ({
        method: "static",
        address: "2001:db8::1/64",
        gateway: "2001:db8::ffff",
        autoDns: false,
        primaryDns: null,
        secondaryDns: null,
        mayFail: true,
        ...overrides,
    });

    test("accepts valid IPv6 DNS", () => {
        expect(validateIpv6DnsConfig(makeIpv6Config({ primaryDns: "2001:4860:4860::8888" }))).toBe(true);
    });

    test("accepts valid IPv6 DNS with secondary", () => {
        expect(
            validateIpv6DnsConfig(
                makeIpv6Config({ primaryDns: "2001:4860:4860::8888", secondaryDns: "2001:4860:4860::8844" }),
            ),
        ).toBe(true);
    });

    test("rejects IPv4 address as IPv6 DNS", () => {
        expect(validateIpv6DnsConfig(makeIpv6Config({ primaryDns: "8.8.8.8" }))).toBe(false);
    });

    test("rejects IPv4 secondary DNS in IPv6 config", () => {
        expect(
            validateIpv6DnsConfig(makeIpv6Config({ primaryDns: "2001:4860:4860::8888", secondaryDns: "8.8.4.4" })),
        ).toBe(false);
    });

    test("accepts autoDns without DNS addresses", () => {
        expect(validateIpv6DnsConfig(makeIpv6Config({ autoDns: true }))).toBe(true);
    });
});

describe("validateURL", () => {
    test("accepts URL with IPv4 address hostname", () => {
        expect(validateURL("https://192.168.122.1:3443")).toBeNull();
    });

    test("accepts URL with DNS hostname", () => {
        expect(validateURL("https://flightctl.example.com:3443")).toBeNull();
    });

    test("accepts URL with hostname prefix before IPv4-like suffix", () => {
        expect(validateURL("https://api.192.124.12.22:333")).toBeNull();
    });

    test("accepts URL with nip.io hostname", () => {
        expect(validateURL("https://api.192.124.12.22.nip.io:333")).toBeNull();
    });

    test("rejects invalid URL format", () => {
        expect(validateURL("not-a-url")).toBe("Invalid URL format");
    });

    test("rejects non-http protocols", () => {
        expect(validateURL("ftp://192.168.122.1:3443")).toBe("URL must use http:// or https:// protocol");
    });
});

describe("validateSystemHostname", () => {
    const INVALID_FORMAT = "Hostname must start and end with an alphanumeric character, and contain only letters, numbers, hyphens, and dots";

    const validCases: [string, string][] = [
        ["simple hostname", "myhost"],
        ["with hyphens", "my-host-01"],
        ["single character", "a"],
        ["numeric only", "123"],
        ["FQDN", "my-host.example.com"],
        ["uppercase", "MyHost"],
        ["64 characters", "a".repeat(64)],
        ["long label over 63 chars", "a".repeat(64)],
        ["FQDN with long label", "a".repeat(60) + ".b"],
        ["empty when not required", ""],
    ];

    test.each(validCases)("accepts %s: %s", (_name, input) => {
        expect(validateSystemHostname(input, false)).toBeNull();
    });

    const invalidCases: [string, string, string][] = [
        ["65 characters", "a".repeat(65), "Hostname must be 64 characters or less"],
        ["empty when required", "", "Hostname is required"],
        ["starting with hyphen", "-myhost", INVALID_FORMAT],
        ["ending with hyphen", "myhost-", INVALID_FORMAT],
        ["starting with dot", ".myhost", INVALID_FORMAT],
        ["ending with dot", "myhost.", INVALID_FORMAT],
        ["consecutive dots", "my..host", INVALID_FORMAT],
        ["underscore", "my_host", INVALID_FORMAT],
        ["spaces", "my host", INVALID_FORMAT],
        ["special characters", "host@name!", INVALID_FORMAT],
    ];

    test.each(invalidCases)("rejects %s: %s", (_name, input, expected) => {
        expect(validateSystemHostname(input)).toBe(expected);
    });
});
