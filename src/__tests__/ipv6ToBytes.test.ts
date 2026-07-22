import { ipv6ToBytes } from "../services/network-utils";

describe("ipv6ToBytes", () => {
    const cases: [string, string, number[]][] = [
        [
            "full expanded address",
            "2001:0db8:0000:0000:0000:0000:0000:0001",
            [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01],
        ],
        [
            "compressed address with ::",
            "2001:db8::1",
            [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01],
        ],
        [
            "loopback (::1)",
            "::1",
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01],
        ],
        [
            "all zeros (::)",
            "::",
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ],
        [
            "Google DNS (2001:4860:4860::8888)",
            "2001:4860:4860::8888",
            [0x20, 0x01, 0x48, 0x60, 0x48, 0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0x88, 0x88],
        ],
        [
            "link-local with leading zeros stripped (fe80::1)",
            "fe80::1",
            [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01],
        ],
        [
            "full 8-group address without compression",
            "fe80:0:0:0:0:0:0:1",
            [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01],
        ],
    ];

    test.each(cases)("%s: %s", (_name, input, expected) => {
        expect(ipv6ToBytes(input)).toEqual(expected);
    });

    test("returns exactly 16 bytes", () => {
        expect(ipv6ToBytes("::")).toHaveLength(16);
        expect(ipv6ToBytes("2001:db8::1")).toHaveLength(16);
        expect(ipv6ToBytes("fe80:0:0:0:0:0:0:1")).toHaveLength(16);
    });
});
