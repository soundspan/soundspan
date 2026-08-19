import { BlockList, isIP } from "node:net";

type AddressFamily = "ipv4" | "ipv6";

interface BlockedSubnet {
    address: string;
    prefix: number;
    family: AddressFamily;
}

const BLOCKED_SUBNETS: readonly BlockedSubnet[] = [
    { address: "0.0.0.0", prefix: 8, family: "ipv4" },
    { address: "10.0.0.0", prefix: 8, family: "ipv4" },
    { address: "100.64.0.0", prefix: 10, family: "ipv4" },
    { address: "127.0.0.0", prefix: 8, family: "ipv4" },
    { address: "169.254.0.0", prefix: 16, family: "ipv4" },
    { address: "172.16.0.0", prefix: 12, family: "ipv4" },
    { address: "192.168.0.0", prefix: 16, family: "ipv4" },
    { address: "198.18.0.0", prefix: 15, family: "ipv4" },
    { address: "::", prefix: 128, family: "ipv6" },
    { address: "::1", prefix: 128, family: "ipv6" },
    { address: "fc00::", prefix: 7, family: "ipv6" },
    { address: "fe80::", prefix: 10, family: "ipv6" },
];

const blockedAddresses = new BlockList();
for (let index = 0; index < BLOCKED_SUBNETS.length; index += 1) {
    const subnet = BLOCKED_SUBNETS[index];
    blockedAddresses.addSubnet(subnet.address, subnet.prefix, subnet.family);
}

function stripAddressDecorators(address: string): string {
    const withoutBrackets = address.replace(/^\[|\]$/g, "");
    return withoutBrackets.split("%", 1)[0].toLowerCase();
}

function decodeMappedIpv4Address(address: string): string | null {
    const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (!match) return null;
    const high = Number.parseInt(match[1], 16);
    const low = Number.parseInt(match[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Returns whether an IP address is denied by the shared outbound SSRF policy. */
export function isBlockedAddress(address: string): boolean {
    const normalized = stripAddressDecorators(address);
    const mappedIpv4 = decodeMappedIpv4Address(normalized);
    if (mappedIpv4) return blockedAddresses.check(mappedIpv4, "ipv4");
    const family = isIP(normalized);
    if (family === 0) return true;
    return blockedAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
}
