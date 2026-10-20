import {
    FileAttribute,
    SlskClient,
    type SearchResult as SlskSearchResult,
} from "slsk-client";
import { logger as rootLogger } from "../../utils/logger";

const logger = rootLogger.child("SoulseekSession");

/** Soulseek server used by the direct client integration. */
export const SOULSEEK_SERVER = Object.freeze({
    host: "server.slsknet.org",
    port: 2242,
});

/** Maximum time allowed for a Soulseek login response. */
export const SOULSEEK_LOGIN_TIMEOUT_MS = 10_000;

/** Search result shape consumed by soundspan's ranking logic. */
export interface SearchResult {
    user: string;
    file: string;
    size: number;
    slots: boolean;
    bitrate?: number;
    speed: number;
}

type SearchResultFields = Partial<Record<keyof SlskSearchResult, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function readBitrate(attribs: unknown): number | undefined {
    if (!isRecord(attribs)) return undefined;
    const bitrate = attribs[FileAttribute.Bitrate];
    return typeof bitrate === "number" &&
        Number.isFinite(bitrate) &&
        bitrate > 0
        ? bitrate
        : undefined;
}

function validateCredentials(username: unknown, password: unknown): void {
    if (
        typeof username !== "string" ||
        typeof password !== "string" ||
        !username ||
        !password
    ) {
        throw new Error("Soulseek username and password are required");
    }
}

/** Creates a v2 client while leaving reconnect ownership with the service. */
export function createSoulseekClient(): SlskClient {
    return new SlskClient({
        ...SOULSEEK_SERVER,
        timeout: SOULSEEK_LOGIN_TIMEOUT_MS,
        reconnect: false,
    });
}

function destroyQuietly(client: SlskClient): void {
    try {
        client.destroy();
    } catch (error) {
        logger.warn("Failed to destroy Soulseek client", { error });
    }
}

/** Logs in and releases all client resources when login cannot complete. */
export async function loginSoulseekClient(
    client: SlskClient,
    username: string,
    password: string,
): Promise<void> {
    try {
        validateCredentials(username, password);
        await client.login(username, password);
    } catch (error) {
        destroyQuietly(client);
        throw error;
    }
}

/** Tests credentials with a short-lived client that is always destroyed. */
export async function testSoulseekCredentials(
    username: string,
    password: string,
): Promise<void> {
    const client = createSoulseekClient();
    await loginSoulseekClient(client, username, password);
    destroyQuietly(client);
}

/** Validates and converts one untrusted peer search result. */
export function normalizeSearchResult(raw: unknown): SearchResult | null {
    if (!isRecord(raw)) return null;
    const result: SearchResultFields = raw;
    if (typeof result.user !== "string" || !result.user) return null;
    if (typeof result.file !== "string" || !result.file) return null;
    if (
        typeof result.size !== "number" ||
        !Number.isFinite(result.size) ||
        result.size < 0
    ) {
        return null;
    }

    const bitrate = readBitrate(result.attribs);
    const speed =
        typeof result.speed === "number" &&
        Number.isFinite(result.speed) &&
        result.speed >= 0
            ? result.speed
            : 0;
    return {
        user: result.user,
        file: result.file,
        size: result.size,
        slots: result.slots === true,
        ...(bitrate === undefined ? {} : { bitrate }),
        speed,
    };
}

/** Validates a complete untrusted search response and drops invalid entries. */
export function normalizeSearchResults(raw: unknown): SearchResult[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((result) => normalizeSearchResult(result))
        .filter((result): result is SearchResult => result !== null);
}
