import axios from "axios";
import { config } from "../config";
import { prisma } from "../utils/db";
import { decrypt, encrypt } from "../utils/encryption";
import { getSystemSettings } from "../utils/systemSettings";
import type { ScrobbleService } from "./scrobbleTypes";
import { createLastFmApiSignature } from "./scrobbleSigning";
import { z } from "zod";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_APPROVAL_URL = "https://www.last.fm/api/auth/";
const LISTENBRAINZ_VALIDATE_URL =
    "https://api.listenbrainz.org/1/validate-token";
const SCROBBLE_HTTP_TIMEOUT_MS = 8_000;
const listenBrainzValidationSchema = z.object({
    valid: z.boolean(),
    user_name: z.string().optional(),
});
const lastFmTokenSchema = z.object({ token: z.string().min(1) });
const lastFmSessionSchema = z.object({
    session: z.object({ key: z.string().min(1), name: z.string().optional() }),
});

export class InvalidListenBrainzTokenError extends Error {
    constructor() {
        super("ListenBrainz rejected the token");
        this.name = "InvalidListenBrainzTokenError";
    }
}

export class LastFmServerConfigurationError extends Error {
    constructor() {
        super("Last.fm scrobbling is not configured on this server");
        this.name = "LastFmServerConfigurationError";
    }
}

export class LastFmAuthStateError extends Error {
    constructor() {
        super("No pending Last.fm authorization was found");
        this.name = "LastFmAuthStateError";
    }
}

export class ScrobbleProviderRequestError extends Error {
    constructor(service: "Last.fm" | "ListenBrainz") {
        super(`${service} request failed`);
        this.name = "ScrobbleProviderRequestError";
    }
}

interface LastFmCredentials {
    apiKey: string;
    sharedSecret: string;
}

/** Resolves the operator API key plus the environment-only shared secret. */
export async function resolveLastFmCredentials(): Promise<LastFmCredentials> {
    const settings = await getSystemSettings();
    const apiKey = settings?.lastfmApiKey || config.lastfm.apiKey;
    const sharedSecret = config.lastfm.sharedSecret;
    if (!apiKey || !sharedSecret) throw new LastFmServerConfigurationError();
    return { apiKey, sharedSecret };
}

/** Whether the operator has configured the Last.fm key pair. */
export async function isLastFmServerConfigured(): Promise<boolean> {
    const settings = await getSystemSettings();
    const apiKey = settings?.lastfmApiKey || config.lastfm.apiKey;
    return Boolean(apiKey && config.lastfm.sharedSecret);
}

/** Validates and encrypts a user's ListenBrainz token before persistence. */
export async function saveListenBrainzToken(
    userId: string,
    token: string,
): Promise<void> {
    let response;
    try {
        response = await axios.get(LISTENBRAINZ_VALIDATE_URL, {
            headers: { Authorization: `Token ${token}` },
            timeout: SCROBBLE_HTTP_TIMEOUT_MS,
        });
    } catch (error: unknown) {
        if (axios.isAxiosError(error) && error.response?.status === 401) {
            throw new InvalidListenBrainzTokenError();
        }
        throw new ScrobbleProviderRequestError("ListenBrainz");
    }
    const validation = listenBrainzValidationSchema.safeParse(response.data);
    if (!validation.success || validation.data.valid !== true) {
        throw new InvalidListenBrainzTokenError();
    }
    const encryptedCredential = encrypt(token);
    await prisma.scrobbleConnection.upsert({
        where: { userId_service: { userId, service: "listenbrainz" } },
        create: {
            userId,
            service: "listenbrainz",
            encryptedCredential,
            username: validation.data.user_name ?? null,
            enabled: true,
        },
        update: {
            encryptedCredential,
            username: validation.data.user_name ?? null,
            enabled: true,
        },
    });
}

/** Starts Last.fm's browser approval flow and stores its request token encrypted. */
export async function startLastFmAuth(userId: string): Promise<string> {
    const credentials = await resolveLastFmCredentials();
    const parameters = {
        method: "auth.getToken",
        api_key: credentials.apiKey,
    };
    let response;
    try {
        response = await axios.get(LASTFM_API_URL, {
            params: {
                ...parameters,
                api_sig: createLastFmApiSignature(
                    parameters,
                    credentials.sharedSecret,
                ),
                format: "json",
            },
            timeout: SCROBBLE_HTTP_TIMEOUT_MS,
        });
    } catch {
        throw new ScrobbleProviderRequestError("Last.fm");
    }
    const tokenResult = lastFmTokenSchema.safeParse(response.data);
    if (!tokenResult.success) {
        throw new Error("Last.fm did not return an authorization token");
    }
    const token = tokenResult.data.token;
    const encryptedPendingToken = encrypt(token);
    await prisma.scrobbleConnection.upsert({
        where: { userId_service: { userId, service: "lastfm" } },
        create: {
            userId,
            service: "lastfm",
            encryptedPendingToken,
            enabled: true,
        },
        update: { encryptedPendingToken },
    });
    const approvalUrl = new URL(LASTFM_APPROVAL_URL);
    approvalUrl.searchParams.set("api_key", credentials.apiKey);
    approvalUrl.searchParams.set("token", token);
    return approvalUrl.toString();
}

/** Completes Last.fm auth and replaces the pending token with a session key. */
export async function completeLastFmAuth(userId: string): Promise<string> {
    const credentials = await resolveLastFmCredentials();
    const connection = await prisma.scrobbleConnection.findUnique({
        where: { userId_service: { userId, service: "lastfm" } },
        select: { encryptedPendingToken: true },
    });
    if (!connection?.encryptedPendingToken) throw new LastFmAuthStateError();
    const token = decrypt(connection.encryptedPendingToken);
    const parameters = {
        method: "auth.getSession",
        api_key: credentials.apiKey,
        token,
    };
    let response;
    try {
        response = await axios.post(
            LASTFM_API_URL,
            new URLSearchParams({
                ...parameters,
                api_sig: createLastFmApiSignature(
                    parameters,
                    credentials.sharedSecret,
                ),
                format: "json",
            }),
            { timeout: SCROBBLE_HTTP_TIMEOUT_MS },
        );
    } catch {
        throw new ScrobbleProviderRequestError("Last.fm");
    }
    const sessionResult = lastFmSessionSchema.safeParse(response.data);
    if (!sessionResult.success) {
        throw new Error("Last.fm did not return a session key");
    }
    const { key: sessionKey, name: username } = sessionResult.data.session;
    const updateResult = await prisma.scrobbleConnection.updateMany({
        where: {
            userId,
            service: "lastfm",
            encryptedPendingToken: connection.encryptedPendingToken,
        },
        data: {
            encryptedCredential: encrypt(sessionKey),
            encryptedPendingToken: null,
            username: username ?? null,
            enabled: true,
        },
    });
    if (updateResult.count === 0) throw new LastFmAuthStateError();
    return username ?? "";
}

/** Returns only non-secret connection state for one user. */
export async function getScrobblingStatus(userId: string) {
    const connections = await prisma.scrobbleConnection.findMany({
        where: { userId },
        select: {
            service: true,
            encryptedCredential: true,
            enabled: true,
            username: true,
        },
        take: 2,
        orderBy: { service: "asc" },
    });
    const byService = new Map(connections.map((row) => [row.service, row]));
    const lastfm = byService.get("lastfm");
    const listenbrainz = byService.get("listenbrainz");
    return {
        lastfm: {
            connected: Boolean(lastfm?.encryptedCredential),
            enabled: Boolean(lastfm?.encryptedCredential && lastfm.enabled),
            username: lastfm?.username ?? null,
            serverConfigured: await isLastFmServerConfigured(),
        },
        listenbrainz: {
            connected: Boolean(listenbrainz?.encryptedCredential),
            enabled: Boolean(
                listenbrainz?.encryptedCredential && listenbrainz.enabled,
            ),
        },
    };
}

/** Disconnects one user-owned scrobbling service. */
export async function disconnectScrobbler(
    userId: string,
    service: ScrobbleService,
): Promise<void> {
    await prisma.scrobbleConnection.deleteMany({ where: { userId, service } });
}

/** Enables or disables an existing user-owned connection. */
export async function setScrobblerEnabled(
    userId: string,
    service: ScrobbleService,
    enabled: boolean,
): Promise<boolean> {
    const result = await prisma.scrobbleConnection.updateMany({
        where: { userId, service, encryptedCredential: { not: null } },
        data: { enabled },
    });
    return result.count > 0;
}
