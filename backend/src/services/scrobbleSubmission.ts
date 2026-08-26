import axios from "axios";
import { prisma } from "../utils/db";
import { decrypt } from "../utils/encryption";
import { createLastFmApiSignature } from "./scrobbleSigning";
import { resolveLastFmCredentials } from "./scrobbleConnections";
import type { ScrobbleJobData } from "./scrobbleTypes";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const LISTENBRAINZ_SUBMIT_URL = "https://api.listenbrainz.org/1/submit-listens";
const SCROBBLE_HTTP_TIMEOUT_MS = 8_000;

export class InvalidScrobbleAuthError extends Error {
    /**
     * Ciphertext of the credential the failed submission actually used, so
     * the invalid-auth disable can compare-and-swap against exactly that
     * row and never clobber a freshly reauthenticated credential.
     */
    readonly encryptedCredential?: string;

    constructor(encryptedCredential?: string) {
        super("Stored scrobbling authorization is invalid");
        this.name = "InvalidScrobbleAuthError";
        this.encryptedCredential = encryptedCredential;
    }
}

export class ScrobbleSubmissionError extends Error {
    constructor() {
        super("Scrobbling provider request failed");
        this.name = "ScrobbleSubmissionError";
    }
}

function readLastFmErrorCode(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return undefined;
    return Reflect.get(value, "error");
}

function isInvalidAuth(cause: unknown): boolean {
    if (cause instanceof InvalidScrobbleAuthError) return true;
    if (!axios.isAxiosError(cause)) return false;
    const providerCode = readLastFmErrorCode(
        Reflect.get(cause.response ?? {}, "data"),
    );
    return (
        cause.response?.status === 401 ||
        providerCode === 4 ||
        providerCode === 9
    );
}

interface LoadedCredential {
    plaintext: string;
    ciphertext: string;
}

async function loadCredential(job: ScrobbleJobData): Promise<LoadedCredential> {
    const connection = await prisma.scrobbleConnection.findUnique({
        where: {
            userId_service: { userId: job.userId, service: job.service },
        },
        select: { encryptedCredential: true, enabled: true },
    });
    if (!connection?.enabled || !connection.encryptedCredential) {
        throw new InvalidScrobbleAuthError();
    }
    try {
        return {
            plaintext: decrypt(connection.encryptedCredential),
            ciphertext: connection.encryptedCredential,
        };
    } catch {
        throw new InvalidScrobbleAuthError(connection.encryptedCredential);
    }
}

async function submitListenBrainz(
    job: ScrobbleJobData,
    token: string,
): Promise<void> {
    const metadata: Record<string, unknown> = {
        artist_name: job.track.artist,
        track_name: job.track.title,
    };
    if (job.track.album) metadata.release_name = job.track.album;
    if (job.track.durationSeconds !== undefined) {
        metadata.additional_info = {
            duration_ms: job.track.durationSeconds * 1000,
        };
    }
    const payload = {
        listen_type: job.kind === "scrobble" ? "single" : "playing_now",
        payload: [
            {
                ...(job.kind === "scrobble"
                    ? { listened_at: job.listenedAtSeconds }
                    : {}),
                track_metadata: metadata,
            },
        ],
    };
    await axios.post(LISTENBRAINZ_SUBMIT_URL, payload, {
        headers: { Authorization: `Token ${token}` },
        timeout: SCROBBLE_HTTP_TIMEOUT_MS,
    });
}

async function submitLastFm(
    job: ScrobbleJobData,
    sessionKey: string,
): Promise<void> {
    const credentials = await resolveLastFmCredentials();
    const parameters: Record<string, string> = {
        method:
            job.kind === "scrobble"
                ? "track.scrobble"
                : "track.updateNowPlaying",
        api_key: credentials.apiKey,
        sk: sessionKey,
        artist: job.track.artist,
        track: job.track.title,
    };
    if (job.track.album) parameters.album = job.track.album;
    if (job.track.durationSeconds !== undefined) {
        parameters.duration = String(job.track.durationSeconds);
    }
    if (job.kind === "scrobble") {
        parameters.timestamp = String(job.listenedAtSeconds);
    }
    const response = await axios.post(
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
    const errorCode = readLastFmErrorCode(Reflect.get(response, "data"));
    if (errorCode === 4 || errorCode === 9) {
        throw new InvalidScrobbleAuthError();
    }
    if (errorCode !== undefined) throw new ScrobbleSubmissionError();
}

/** Submits one durable queue job using a freshly loaded encrypted credential. */
export async function submitScrobbleJob(job: ScrobbleJobData): Promise<void> {
    const credential = await loadCredential(job);
    try {
        if (job.service === "listenbrainz") {
            await submitListenBrainz(job, credential.plaintext);
            return;
        }
        await submitLastFm(job, credential.plaintext);
    } catch (error: unknown) {
        if (isInvalidAuth(error)) {
            throw new InvalidScrobbleAuthError(credential.ciphertext);
        }
        throw new ScrobbleSubmissionError();
    }
}
