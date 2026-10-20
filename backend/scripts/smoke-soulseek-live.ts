/**
 * Checks credential testing, login, search normalization, and one live download.
 * The person running it must supply a real Soulseek account through the smoke
 * environment variables. It downloads one small file from a peer and deletes
 * it. CI never runs this script.
 */

import { mkdtemp, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import type { SlskClient } from "slsk-client";
import {
    createSoulseekClient,
    loginSoulseekClient,
    normalizeSearchResults,
    testSoulseekCredentials,
    type SearchResult,
} from "../src/services/soulseek/slskSession";

const DEFAULT_QUERY = "aphex twin xtal";
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".m4a", ".ogg", ".opus"]);

interface SmokeConfig {
    username: string;
    password: string;
    query: string;
    maxBytes: number;
}

function assertCondition(
    condition: unknown,
    message: string,
): asserts condition {
    if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function safeDisplay(value: string, password: string): string {
    const withoutPassword = value.split(password).join("[redacted]");
    return withoutPassword.replace(/[\u0000-\u001f\u007f]/g, "?");
}

function elapsedMs(startedAt: number): number {
    return Date.now() - startedAt;
}

function parseMaxBytes(value: string | undefined): number {
    if (value === undefined) return DEFAULT_MAX_BYTES;
    const parsed = Number(value);
    assertCondition(
        Number.isSafeInteger(parsed) && parsed > 0,
        "SOULSEEK_SMOKE_MAX_BYTES must be a positive integer",
    );
    return parsed;
}

function validateConfig(values: {
    username: string | undefined;
    password: string | undefined;
    query: string | undefined;
    maxBytes: string | undefined;
}): SmokeConfig {
    assertCondition(
        values.username && values.password,
        "set SOULSEEK_SMOKE_USERNAME and SOULSEEK_SMOKE_PASSWORD",
    );
    return {
        username: values.username,
        password: values.password,
        query: values.query?.trim() || DEFAULT_QUERY,
        maxBytes: parseMaxBytes(values.maxBytes),
    };
}

function registerClientListeners(client: SlskClient, password: string): void {
    client.on("server-error", (error) => {
        console.warn(
            `smoke: event server-error: ${safeDisplay(error.message, password)}`,
        );
    });
    client.on("listen-error", (error) => {
        console.warn(
            `smoke: event listen-error: ${safeDisplay(error.message, password)}`,
        );
    });
    client.on("server-disconnect", ({ reconnecting }) => {
        console.warn(
            `smoke: event server-disconnect: connection closed (reconnecting=${reconnecting})`,
        );
    });
    client.on("relogged", () => {
        console.warn(
            "smoke: event relogged: another client, such as a running soundspan instance, is using this account",
        );
    });
}

async function verifyCredentials(config: SmokeConfig): Promise<void> {
    const startedAt = Date.now();
    try {
        await testSoulseekCredentials(config.username, config.password);
    } catch (error) {
        throw new Error(safeDisplay(errorMessage(error), config.password));
    }
    console.log(`smoke: credentials verified (${elapsedMs(startedAt)}ms)`);
}

async function loginClient(config: SmokeConfig): Promise<SlskClient> {
    const startedAt = Date.now();
    const client = createSoulseekClient();
    registerClientListeners(client, config.password);
    try {
        await loginSoulseekClient(client, config.username, config.password);
    } catch (error) {
        throw new Error(safeDisplay(errorMessage(error), config.password));
    }
    console.log(`smoke: client logged in (${elapsedMs(startedAt)}ms)`);
    return client;
}

async function searchLive(
    client: SlskClient,
    config: SmokeConfig,
): Promise<SearchResult[]> {
    const startedAt = Date.now();
    let raw: unknown;
    try {
        raw = await client.search({
            req: config.query,
            timeout: SEARCH_TIMEOUT_MS,
        });
    } catch (error) {
        throw new Error(safeDisplay(errorMessage(error), config.password));
    }
    const normalized = normalizeSearchResults(raw);
    const rawCount = Array.isArray(raw) ? raw.length : 0;
    const bitrateCount = normalized.filter(
        (result) => result.bitrate !== undefined,
    ).length;
    console.log(
        `smoke: search returned raw=${rawCount} normalized=${normalized.length} bitrate=${bitrateCount} (${elapsedMs(startedAt)}ms)`,
    );
    assertCondition(
        normalized.length > 0,
        "search returned no normalized results",
    );
    return normalized;
}

function selectCandidates(
    results: readonly SearchResult[],
    maxBytes: number,
): SearchResult[] {
    return results
        .filter((result) => {
            const extension = path
                .extname(remoteBaseName(result.file))
                .toLowerCase();
            return (
                AUDIO_EXTENSIONS.has(extension) &&
                result.size > 0 &&
                result.size <= maxBytes
            );
        })
        .sort(
            (left, right) =>
                Number(right.slots) - Number(left.slots) ||
                left.size - right.size,
        );
}

function chooseCandidates(
    results: readonly SearchResult[],
    maxBytes: number,
): SearchResult[] {
    const startedAt = Date.now();
    const candidates = selectCandidates(results, maxBytes);
    console.log(
        `smoke: selected ${candidates.length} download candidates (${elapsedMs(startedAt)}ms)`,
    );
    assertCondition(
        candidates.length > 0,
        "search returned no eligible audio files",
    );
    return candidates;
}

function remoteBaseName(remotePath: string): string {
    return remotePath.split(/[\\/]/).pop() || "download";
}

async function tryDownload(
    client: SlskClient,
    candidate: SearchResult,
    destination: string,
): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const result = await client.download({
            user: candidate.user,
            file: candidate.file,
            size: candidate.size,
            path: destination,
            signal: controller.signal,
        });
        const written = await stat(destination);
        assertCondition(written.size > 0, "downloaded file is empty");
        assertCondition(
            written.size === result.receivedBytes,
            `file size ${written.size} does not equal receivedBytes ${result.receivedBytes}`,
        );
        return written.size;
    } finally {
        clearTimeout(timer);
    }
}

async function downloadFirstCandidate(
    client: SlskClient,
    candidates: readonly SearchResult[],
    tempDir: string,
    password: string,
): Promise<void> {
    const errors: string[] = [];
    const stepStartedAt = Date.now();
    for (let index = 0; index < MAX_DOWNLOAD_ATTEMPTS; index += 1) {
        const candidate = candidates[index];
        if (!candidate) break;
        const name = safeDisplay(remoteBaseName(candidate.file), password);
        const peer = safeDisplay(candidate.user, password);
        const destination = path.join(tempDir, `candidate-${index + 1}`);
        const attemptStartedAt = Date.now();
        try {
            const size = await tryDownload(client, candidate, destination);
            console.log(
                `smoke: download attempt ${index + 1} succeeded peer=${peer} file=${name} bytes=${size} (${elapsedMs(attemptStartedAt)}ms)`,
            );
            console.log(
                `smoke: download verified (${elapsedMs(stepStartedAt)}ms)`,
            );
            return;
        } catch (error) {
            const message = safeDisplay(errorMessage(error), password);
            errors.push(`${peer}/${name}: ${message}`);
            console.log(
                `smoke: download attempt ${index + 1} failed peer=${peer} file=${name}: ${message} (${elapsedMs(attemptStartedAt)}ms)`,
            );
        }
    }
    throw new Error(`all download attempts failed: ${errors.join("; ")}`);
}

async function cleanup(
    client: SlskClient | null,
    tempDir: string | null,
    password: string,
): Promise<void> {
    try {
        client?.destroy();
    } catch (error) {
        console.warn(
            `smoke: client cleanup failed: ${safeDisplay(errorMessage(error), password)}`,
        );
    } finally {
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
        }
    }
}

async function runSmoke(config: SmokeConfig): Promise<void> {
    let client: SlskClient | null = null;
    let tempDir: string | null = null;
    try {
        await verifyCredentials(config);
        client = await loginClient(config);
        const results = await searchLive(client, config);
        const candidates = chooseCandidates(results, config.maxBytes);
        tempDir = await mkdtemp(
            path.join(os.tmpdir(), "soundspan-slsk-smoke-"),
        );
        await downloadFirstCandidate(
            client,
            candidates,
            tempDir,
            config.password,
        );
        console.log("smoke: live Soulseek check passed");
    } finally {
        await cleanup(client, tempDir, config.password);
    }
}

async function main(): Promise<void> {
    const config = validateConfig({
        username: process.env.SOULSEEK_SMOKE_USERNAME,
        password: process.env.SOULSEEK_SMOKE_PASSWORD,
        query: process.env.SOULSEEK_SMOKE_QUERY,
        maxBytes: process.env.SOULSEEK_SMOKE_MAX_BYTES,
    });
    await runSmoke(config);
}

main().catch((error) => {
    console.error(`smoke: ${errorMessage(error)}`);
    process.exitCode = 1;
});
