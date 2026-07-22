export function ipv6ToBytes(ip: string): number[] {
    // Expand :: notation and convert to 16 bytes
    const parts = ip.split(":");
    const result: number[] = new Array(16).fill(0);

    // Handle :: expansion
    const doubleColonIndex = parts.indexOf("");
    if (doubleColonIndex !== -1) {
        const before = parts.slice(0, doubleColonIndex).filter((p) => p !== "");
        const after = parts.slice(doubleColonIndex + 1).filter((p) => p !== "");
        const missing = 8 - before.length - after.length;

        const expanded = [...before, ...new Array(missing).fill("0"), ...after];

        for (let i = 0; i < 8; i++) {
            const val = parseInt(expanded[i] || "0", 16);
            result[i * 2] = (val >> 8) & 0xff;
            result[i * 2 + 1] = val & 0xff;
        }
    } else {
        for (let i = 0; i < 8; i++) {
            const val = parseInt(parts[i] || "0", 16);
            result[i * 2] = (val >> 8) & 0xff;
            result[i * 2 + 1] = val & 0xff;
        }
    }

    return result;
}
