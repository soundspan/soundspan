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
const lastFmErrorSchema = z.object({
    error: z.number().int(),
    message: z.string().optional(),
});
const LASTFM_APPROVAL_REQUIRED_MESSAGE =
    "Approve access in the Last.fm tab, then try again";
const LASTFM_CREDENTIALS_REJECTED_MESSAGE =
    "The server's Last.fm API key or shared secret was rejected by Last.fm";

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
    constructor(message = "No pending Last.fm authorization was found") {
        super(message);
        this.name = "LastFmAuthStateError";
    }
}

/** Indicates that Last.fm rejected the operator-managed server credentials. */
export class LastFmCredentialsRejectedError extends Error {
    constructor() {
        super(LASTFM_CREDENTIALS_REJECTED_MESSAGE);
        this.name = "LastFmCredentialsRejectedError";
    }
}

export class ScrobbleProviderRequestError extends Error {
    constructor(public readonly service: "Last.fm" | "ListenBrainz") {
        super(`${service} request failed`);
        this.name = "ScrobbleProviderRequestError";
    }
}

interface LastFmCredentials {
    apiKey: string;
    sharedSecret: string;
}

interface LastFmConfigurationState extends LastFmCredentials {
    apiKeyConfigured: boolean;
    sharedSecretConfigured: boolean;
    serverConfigured: boolean;
}

async function getLastFmConfigurationState(): Promise<LastFmConfigurationState> {
    const settings = await getSystemSettings();
    const apiKey = settings?.lastfmApiKey || config.lastfm.apiKey;
    const sharedSecret = config.lastfm.sharedSecret;
    const apiKeyConfigured = Boolean(apiKey);
    const sharedSecretConfigured = Boolean(sharedSecret);
    return {
        apiKey,
        sharedSecret,
        apiKeyConfigured,
        sharedSecretConfigured,
        serverConfigured: apiKeyConfigured && sharedSecretConfigured,
    };
}

function createLastFmResponseError(code: number): Error {
    if (code === 14 || code === 15) {
        return new LastFmAuthStateError(LASTFM_APPROVAL_REQUIRED_MESSAGE);
    }
    if (code === 4 || code === 10 || code === 13 || code === 26) {
        return new LastFmCredentialsRejectedError();
    }
    return new ScrobbleProviderRequestError("Last.fm");
}

async function callLastFm(
    request: () => Promise<{ data: unknown; status: number }>,
): Promise<unknown> {
    let response: { data: unknown; status: number };
    try {
        response = await request();
    } catch {
        throw new ScrobbleProviderRequestError("Last.fm");
    }
    const lastFmError = lastFmErrorSchema.safeParse(response.data);
    if (lastFmError.success) {
        throw createLastFmResponseError(lastFmError.data.error);
    }
    if (response.status < 200 || response.status >= 300) {
        throw new ScrobbleProviderRequestError("Last.fm");
    }
    return response.data;
}

/** Resolves the operator API key plus the environment-only shared secret. */
export async function resolveLastFmCredentials(): Promise<LastFmCredentials> {
    const configuration = await getLastFmConfigurationState();
    if (!configuration.serverConfigured) {
        throw new LastFmServerConfigurationError();
    }
    return {
        apiKey: configuration.apiKey,
        sharedSecret: configuration.sharedSecret,
    };
}

/** Whether the operator has configured the Last.fm key pair. */
export async function isLastFmServerConfigured(): Promise<boolean> {
    return (await getLastFmConfigurationState()).serverConfigured;
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
    const responseData = await callLastFm(() =>
        axios.get(LASTFM_API_URL, {
            params: {
                ...parameters,
                api_sig: createLastFmApiSignature(
                    parameters,
                    credentials.sharedSecret,
                ),
                format: "json",
            },
            timeout: SCROBBLE_HTTP_TIMEOUT_MS,
            validateStatus: () => true,
        }),
    );
    const tokenResult = lastFmTokenSchema.safeParse(responseData);
    if (!tokenResult.success) {
        throw new ScrobbleProviderRequestError("Last.fm");
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
    const responseData = await callLastFm(() =>
        axios.post(
            LASTFM_API_URL,
            new URLSearchParams({
                ...parameters,
                api_sig: createLastFmApiSignature(
                    parameters,
                    credentials.sharedSecret,
                ),
                format: "json",
            }),
            {
                timeout: SCROBBLE_HTTP_TIMEOUT_MS,
                validateStatus: () => true,
            },
        ),
    );
    const sessionResult = lastFmSessionSchema.safeParse(responseData);
    if (!sessionResult.success) {
        throw new ScrobbleProviderRequestError("Last.fm");
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
    const [connections, lastFmConfiguration] = await Promise.all([
        prisma.scrobbleConnection.findMany({
            where: { userId },
            select: {
                service: true,
                encryptedCredential: true,
                enabled: true,
                username: true,
            },
            take: 2,
            orderBy: { service: "asc" },
        }),
        getLastFmConfigurationState(),
    ]);
    const byService = new Map(connections.map((row) => [row.service, row]));
    const lastfm = byService.get("lastfm");
    const listenbrainz = byService.get("listenbrainz");
    return {
        lastfm: {
            connected: Boolean(lastfm?.encryptedCredential),
            enabled: Boolean(lastfm?.encryptedCredential && lastfm.enabled),
            username: lastfm?.username ?? null,
            serverConfigured: lastFmConfiguration.serverConfigured,
            apiKeyConfigured: lastFmConfiguration.apiKeyConfigured,
            sharedSecretConfigured: lastFmConfiguration.sharedSecretConfigured,
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
