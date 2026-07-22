/**
 * Unit tests for IP address and network configuration validation logic
 *
 * These tests verify that the validation functions correctly implement
 * IPv4, IPv6, subnet mask, and DNS validation as specified in data-model.md
 */

import { validateIPv4, validateSubnetMask, validateIPv6, validateIPv6Gateway, validateIPv6GatewaySubnet, validateIP } from "../../validation";

describe("validateIPv4 - IPv4 Address Validation", () => {
    describe("Required field validation", () => {
        test("returns error for empty string", () => {
            expect(validateIPv4("")).toBe("IPv4 address is required");
        });

        test("returns error for whitespace only", () => {
            expect(validateIPv4("   ")).toBe("IPv4 address is required");
            expect(validateIPv4("\t")).toBe("IPv4 address is required");
        });
    });

    describe("Format validation", () => {
        test("accepts valid IPv4 addresses", () => {
            expect(validateIPv4("192.168.1.1")).toBeNull();
            expect(validateIPv4("10.0.0.1")).toBeNull();
            expect(validateIPv4("172.16.0.1")).toBeNull();
            expect(validateIPv4("8.8.8.8")).toBeNull();
            expect(validateIPv4("255.255.255.255")).toBeNull();
            expect(validateIPv4("0.0.0.0")).toBeNull();
        });

        test("rejects invalid format", () => {
            expect(validateIPv4("192.168.1")).not.toBeNull();
            expect(validateIPv4("192.168")).not.toBeNull();
            expect(validateIPv4("192")).not.toBeNull();
            expect(validateIPv4("192.168.1.1.1")).not.toBeNull();
            expect(validateIPv4("not-an-ip")).not.toBeNull();
            expect(validateIPv4("192.168.1.a")).not.toBeNull();
        });

        test("rejects IPv6 addresses", () => {
            expect(validateIPv4("2001:db8::1")).not.toBeNull();
            expect(validateIPv4("::1")).not.toBeNull();
        });
    });

    describe("Octet range validation (0-255)", () => {
        test("accepts octets at boundaries", () => {
            expect(validateIPv4("0.0.0.0")).toBeNull();
            expect(validateIPv4("255.255.255.255")).toBeNull();
            expect(validateIPv4("192.168.0.1")).toBeNull();
        });

        test("rejects octets over 255", () => {
            expect(validateIPv4("256.1.1.1")).toBe("IPv4 octets must be between 0 and 255");
            expect(validateIPv4("1.256.1.1")).toBe("IPv4 octets must be between 0 and 255");
            expect(validateIPv4("1.1.256.1")).toBe("IPv4 octets must be between 0 and 255");
            expect(validateIPv4("1.1.1.256")).toBe("IPv4 octets must be between 0 and 255");
            expect(validateIPv4("300.1.1.1")).toBe("IPv4 octets must be between 0 and 255");
            expect(validateIPv4("999.999.999.999")).toBe("IPv4 octets must be between 0 and 255");
        });
    });

    describe("Common valid addresses", () => {
        test("accepts localhost and private ranges", () => {
            expect(validateIPv4("127.0.0.1")).toBeNull(); // localhost
            expect(validateIPv4("10.0.0.1")).toBeNull(); // Class A private
            expect(validateIPv4("172.16.0.1")).toBeNull(); // Class B private
            expect(validateIPv4("192.168.1.1")).toBeNull(); // Class C private
        });

        test("accepts public DNS servers", () => {
            expect(validateIPv4("8.8.8.8")).toBeNull(); // Google DNS
            expect(validateIPv4("1.1.1.1")).toBeNull(); // Cloudflare DNS
        });
    });
});

describe("validateSubnetMask - Subnet Mask Validation", () => {
    describe("Required field validation", () => {
        test("returns error for empty string", () => {
            expect(validateSubnetMask("")).toBe("Subnet mask is required");
        });

        test("returns error for whitespace only", () => {
            expect(validateSubnetMask("   ")).toBe("Subnet mask is required");
        });
    });

    describe("CIDR notation validation", () => {
        test("accepts valid CIDR prefixes", () => {
            expect(validateSubnetMask("/0")).toBeNull();
            expect(validateSubnetMask("/8")).toBeNull();
            expect(validateSubnetMask("/16")).toBeNull();
            expect(validateSubnetMask("/24")).toBeNull();
            expect(validateSubnetMask("/32")).toBeNull();
        });

        test("rejects invalid CIDR prefixes", () => {
            expect(validateSubnetMask("/-1")).toBe("CIDR prefix must be between 0 and 32");
            expect(validateSubnetMask("/33")).toBe("CIDR prefix must be between 0 and 32");
            expect(validateSubnetMask("/100")).toBe("CIDR prefix must be between 0 and 32");
            expect(validateSubnetMask("/abc")).toBe("CIDR prefix must be between 0 and 32");
        });
    });

    describe("Dotted decimal notation validation", () => {
        test("accepts valid subnet masks", () => {
            expect(validateSubnetMask("255.255.255.255")).toBeNull(); // /32
            expect(validateSubnetMask("255.255.255.0")).toBeNull(); // /24
            expect(validateSubnetMask("255.255.0.0")).toBeNull(); // /16
            expect(validateSubnetMask("255.0.0.0")).toBeNull(); // /8
            expect(validateSubnetMask("255.255.255.128")).toBeNull(); // /25
            expect(validateSubnetMask("255.255.255.192")).toBeNull(); // /26
            expect(validateSubnetMask("255.255.255.224")).toBeNull(); // /27
            expect(validateSubnetMask("255.255.255.240")).toBeNull(); // /28
            expect(validateSubnetMask("255.255.255.248")).toBeNull(); // /29
            expect(validateSubnetMask("255.255.255.252")).toBeNull(); // /30
        });

        test("rejects invalid subnet masks (non-consecutive bits)", () => {
            expect(validateSubnetMask("255.0.255.0")).toBe(
                "Invalid subnet mask - must have consecutive 1s followed by 0s"
            );
            expect(validateSubnetMask("255.255.0.255")).toBe(
                "Invalid subnet mask - must have consecutive 1s followed by 0s"
            );
            expect(validateSubnetMask("192.168.1.1")).toBe(
                "Invalid subnet mask - must have consecutive 1s followed by 0s"
            );
        });

        test("rejects invalid format", () => {
            expect(validateSubnetMask("255.255.255")).not.toBeNull();
            expect(validateSubnetMask("255.255.255.256")).not.toBeNull();
            expect(validateSubnetMask("not-a-mask")).not.toBeNull();
        });
    });

    describe("Common subnet masks", () => {
        test("accepts standard subnet masks", () => {
            expect(validateSubnetMask("255.255.255.0")).toBeNull(); // /24 - Class C
            expect(validateSubnetMask("255.255.0.0")).toBeNull(); // /16 - Class B
            expect(validateSubnetMask("255.0.0.0")).toBeNull(); // /8 - Class A
        });
    });
});

describe("validateIPv6 - IPv6 Address Validation", () => {
    describe("Required field validation", () => {
        test("returns null for empty string when not required", () => {
            expect(validateIPv6("", false)).toBeNull();
        });

        test("returns error for empty string when required", () => {
            expect(validateIPv6("", true)).toBe("IPv6 address is required");
        });

        test("returns error for whitespace when required", () => {
            expect(validateIPv6("   ", true)).toBe("IPv6 address is required");
        });
    });

    describe("Format validation", () => {
        test("accepts valid full IPv6 addresses", () => {
            expect(validateIPv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toBeNull();
            expect(validateIPv6("2001:0db8:0000:0042:0000:8a2e:0370:7334")).toBeNull();
            expect(validateIPv6("fe80:0000:0000:0000:0204:61ff:fe9d:f156")).toBeNull();
        });

        test("accepts valid compressed IPv6 addresses", () => {
            expect(validateIPv6("2001:db8::1")).toBeNull();
            expect(validateIPv6("2001:db8::8a2e:370:7334")).toBeNull();
            expect(validateIPv6("::1")).toBeNull(); // localhost
            expect(validateIPv6("::")).toBeNull(); // all zeros
            expect(validateIPv6("fe80::")).toBeNull(); // link-local
            expect(validateIPv6("2001:db8::")).toBeNull();
            expect(validateIPv6("::ffff:192.0.2.1")).toBeNull(); // IPv4-mapped
        });

        test("accepts valid IPv6 with prefix", () => {
            expect(validateIPv6("2001:db8::1/64")).toBeNull();
            expect(validateIPv6("2001:db8::1/128")).toBeNull();
            expect(validateIPv6("fe80::/10")).toBeNull();
            expect(validateIPv6("::1/128")).toBeNull();
        });

        test("rejects invalid IPv6 addresses", () => {
            expect(validateIPv6("gggg::")).not.toBeNull();
            expect(validateIPv6("2001:db8::g")).not.toBeNull();
            expect(validateIPv6("12345::")).not.toBeNull(); // Invalid hex (more than 4 digits)
            expect(validateIPv6("192.168.1.1")).not.toBeNull(); // IPv4
        });

        test("rejects multiple :: compressions", () => {
            expect(validateIPv6("2001::db8::1")).toBe("Invalid IPv6 address format");
        });
    });

    describe("Prefix validation", () => {
        test("accepts valid prefix ranges (0-128)", () => {
            expect(validateIPv6("2001:db8::1/0")).toBeNull();
            expect(validateIPv6("2001:db8::1/64")).toBeNull();
            expect(validateIPv6("2001:db8::1/128")).toBeNull();
        });

        test("rejects invalid prefix ranges", () => {
            expect(validateIPv6("2001:db8::1/-1")).toBe("IPv6 prefix must be between 0 and 128");
            expect(validateIPv6("2001:db8::1/129")).toBe("IPv6 prefix must be between 0 and 128");
            expect(validateIPv6("2001:db8::1/256")).toBe("IPv6 prefix must be between 0 and 128");
        });

        test("requires prefix when requirePrefix is true", () => {
            expect(validateIPv6("2001:db8::1", true)).toBe("IPv6 address must include prefix (e.g., /64)");
            expect(validateIPv6("2001:db8::1/64", true)).toBeNull();
        });

        test("allows missing prefix when requirePrefix is false", () => {
            expect(validateIPv6("2001:db8::1", false)).toBeNull();
        });
    });

    describe("Common IPv6 addresses", () => {
        test("accepts localhost and link-local", () => {
            expect(validateIPv6("::1")).toBeNull(); // localhost
            expect(validateIPv6("fe80::")).toBeNull(); // link-local
            expect(validateIPv6("fe80::1")).toBeNull();
        });

        test("accepts public addresses", () => {
            expect(validateIPv6("2001:4860:4860::8888")).toBeNull(); // Google DNS
            expect(validateIPv6("2606:4700:4700::1111")).toBeNull(); // Cloudflare DNS
        });
    });
});

describe("validateIPv6Gateway - IPv6 Gateway Validation", () => {
    describe("Optional field validation", () => {
        test("returns null for empty string", () => {
            expect(validateIPv6Gateway("")).toBeNull();
        });

        test("returns null for whitespace only", () => {
            expect(validateIPv6Gateway("   ")).toBeNull();
        });
    });

    describe("Valid gateway addresses", () => {
        test("accepts valid IPv6 gateway addresses", () => {
            expect(validateIPv6Gateway("2001:db8::1")).toBeNull();
            expect(validateIPv6Gateway("2001:db8::ffff")).toBeNull();
            expect(validateIPv6Gateway("2606:4700:4700::1111")).toBeNull();
        });
    });

    describe("Link-local address acceptance", () => {
        test("accepts fe80:: link-local addresses as valid gateways", () => {
            expect(validateIPv6Gateway("fe80::")).toBeNull();
            expect(validateIPv6Gateway("fe80::1")).toBeNull();
            expect(validateIPv6Gateway("FE80::1")).toBeNull();
            expect(validateIPv6Gateway("fe80::1:2:3:4")).toBeNull();
        });

        test("accepts non-link-local addresses", () => {
            expect(validateIPv6Gateway("2001:db8::1")).toBeNull();
            expect(validateIPv6Gateway("fd00::1")).toBeNull(); // ULA
        });
    });

    describe("Invalid format rejection", () => {
        test("rejects invalid IPv6 format", () => {
            expect(validateIPv6Gateway("not-an-ipv6")).not.toBeNull();
            expect(validateIPv6Gateway("192.168.1.1")).not.toBeNull();
            expect(validateIPv6Gateway("gggg::")).not.toBeNull();
        });
    });
});

describe("validateIPv6GatewaySubnet - IPv6 Gateway Subnet Validation", () => {
    const SUBNET_ERROR = "Gateway is not in the same subnet as the IPv6 address";

    describe("same subnet (valid)", () => {
        const validCases: [string, string, string][] = [
            ["same /64 subnet", "2001:db8::1/64", "2001:db8::2"],
            ["same /48 subnet", "2001:db8:abcd::1/48", "2001:db8:abcd:ffff::1"],
            ["/128 exact match", "2001:db8::1/128", "2001:db8::1"],
            ["same /32 subnet", "2001:db8::1/32", "2001:db8:ffff::1"],
            ["same /1 subnet (broad)", "8000::1/1", "8000::2"],
        ];

        test.each(validCases)("%s", (_name, address, gateway) => {
            expect(validateIPv6GatewaySubnet(address, gateway)).toBeNull();
        });
    });

    describe("different subnet (invalid)", () => {
        const invalidCases: [string, string, string][] = [
            ["different /64 subnet", "2001:db8:1::1/64", "2001:db8:2::1"],
            ["different /48 subnet", "2001:db8:abcd::1/48", "2001:db8:abce::1"],
            ["/128 mismatch", "2001:db8::1/128", "2001:db8::2"],
        ];

        test.each(invalidCases)("%s", (_name, address, gateway) => {
            expect(validateIPv6GatewaySubnet(address, gateway)).toBe(SUBNET_ERROR);
        });
    });

    describe("fe80:: link-local gateway bypass", () => {
        const linkLocalCases: [string, string, string][] = [
            ["fe80:: gateway with global address", "2001:db8::1/64", "fe80::1"],
            ["fe80:: gateway with different prefix", "fd00::1/48", "fe80::abcd:1234"],
            ["FE80:: uppercase", "2001:db8::1/64", "FE80::1"],
        ];

        test.each(linkLocalCases)("%s", (_name, address, gateway) => {
            expect(validateIPv6GatewaySubnet(address, gateway)).toBeNull();
        });
    });

    describe("empty/missing values", () => {
        const emptyCases: [string, string, string][] = [
            ["empty gateway", "2001:db8::1/64", ""],
            ["empty address", "", "2001:db8::1"],
            ["both empty", "", ""],
            ["whitespace gateway", "2001:db8::1/64", "   "],
            ["address without prefix", "2001:db8::1", "2001:db8::2"],
        ];

        test.each(emptyCases)("%s", (_name, address, gateway) => {
            expect(validateIPv6GatewaySubnet(address, gateway)).toBeNull();
        });
    });

    describe("invalid input format", () => {
        test("invalid address format returns null (skips check)", () => {
            expect(validateIPv6GatewaySubnet("not-valid/64", "2001:db8::1")).toBeNull();
        });

        test("invalid gateway format returns null (skips check)", () => {
            expect(validateIPv6GatewaySubnet("2001:db8::1/64", "not-valid")).toBeNull();
        });
    });
});

describe("Validation integration - Real-world scenarios", () => {
    describe("Static IPv4 configuration", () => {
        test("validates typical home network setup", () => {
            const address = "192.168.1.100";
            const subnetMask = "255.255.255.0";
            const gateway = "192.168.1.1";
            const primaryDns = "8.8.8.8";
            const secondaryDns = "8.8.4.4";

            expect(validateIPv4(address)).toBeNull();
            expect(validateSubnetMask(subnetMask)).toBeNull();
            expect(validateIPv4(gateway)).toBeNull();
            expect(validateIP(primaryDns, true)).toBeNull();
            expect(validateIP(secondaryDns, false)).toBeNull();
        });

        test("validates enterprise network setup", () => {
            const address = "10.50.100.25";
            const subnetMask = "/16";
            const gateway = "10.50.0.1";
            const dns = "10.50.1.10";

            expect(validateIPv4(address)).toBeNull();
            expect(validateSubnetMask(subnetMask)).toBeNull();
            expect(validateIPv4(gateway)).toBeNull();
            expect(validateIP(dns, true)).toBeNull();
        });
    });

    describe("Static IPv6 configuration", () => {
        test("validates typical IPv6 setup", () => {
            const address = "2001:db8::1/64";
            const gateway = "2001:db8::ffff";
            const primaryDns = "2001:4860:4860::8888";
            const secondaryDns = "2001:4860:4860::8844";

            expect(validateIPv6(address, true)).toBeNull();
            expect(validateIPv6Gateway(gateway)).toBeNull();
            expect(validateIP(primaryDns, true)).toBeNull();
            expect(validateIP(secondaryDns, false)).toBeNull();
        });
    });

    describe("Invalid configurations", () => {
        test("detects invalid static IPv4 configuration", () => {
            const address = "256.1.1.1"; // Invalid octet
            const subnetMask = "255.0.255.0"; // Non-consecutive bits
            const gateway = "not-an-ip"; // Invalid format

            expect(validateIPv4(address)).not.toBeNull();
            expect(validateSubnetMask(subnetMask)).not.toBeNull();
            expect(validateIPv4(gateway)).not.toBeNull();
        });

        test("accepts IPv6 link-local gateway with non-link-local address", () => {
            const address = "2001:db8::1/64";
            const gateway = "fe80::1";

            expect(validateIPv6(address, true)).toBeNull();
            expect(validateIPv6Gateway(gateway)).toBeNull();
            expect(validateIPv6GatewaySubnet(address, gateway)).toBeNull();
        });
    });
});
