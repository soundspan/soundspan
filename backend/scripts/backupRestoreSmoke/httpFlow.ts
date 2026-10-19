import fsSync from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertSmoke, bearer, expectJson, fetchBounded } from "./support";

const ADMIN_USERNAME = "smoke-admin";
const ADMIN_PASSWORD = "smoke-admin-password";
const BACKUP_PASSPHRASE = "smoke-passphrase-123";
const ENCRYPTED_SETTING = "smoke-lastfm-secret";
const PLAYLIST_NAME = "Smoke Restore Playlist";
const MAX_UPLOAD_CHUNKS = 100_000;

function jsonHeaders(token?: string): Record<string, string> {
    return {
        "Content-Type": "application/json",
        ...(token ? bearer(token) : {}),
    };
}

export async function registerAndSeedApi(baseUrl: string): Promise<string> {
    const registration = await expectJson(
        await fetchBounded(`${baseUrl}/api/onboarding/register`, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({
                username: ADMIN_USERNAME,
                password: ADMIN_PASSWORD,
            }),
        }),
        200,
    );
    assertSmoke(
        typeof registration.token === "string",
        "Registration did not return a token",
    );
    const token = registration.token;
    await expectJson(
        await fetchBounded(`${baseUrl}/api/system-settings`, {
            method: "POST",
            headers: jsonHeaders(token),
            body: JSON.stringify({ lastfmApiKey: ENCRYPTED_SETTING }),
        }),
        200,
    );
    await expectJson(
        await fetchBounded(`${baseUrl}/api/playlists`, {
            method: "POST",
            headers: jsonHeaders(token),
            body: JSON.stringify({ name: PLAYLIST_NAME, isPublic: false }),
        }),
        200,
    );
    return token;
}

export async function downloadBackup(
    baseUrl: string,
    token: string,
    archivePath: string,
): Promise<number> {
    const session = await fetchBounded(`${baseUrl}/api/backup/session`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ passphrase: BACKUP_PASSPHRASE }),
    });
    assertSmoke(
        session.status === 204,
        `Backup session returned ${session.status}`,
    );
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    assertSmoke(cookie, "Backup session did not set its one-use cookie");
    const download = await fetchBounded(`${baseUrl}/api/backup/download`, {
        headers: { Cookie: cookie },
    });
    assertSmoke(
        download.status === 200,
        `Backup download returned ${download.status}`,
    );
    const disposition = download.headers.get("content-disposition") ?? "";
    assertSmoke(
        /^attachment; filename="soundspan-backup-\d{8}-\d{6}Z\.soundspan-backup"$/.test(
            disposition,
        ),
        `Unexpected backup filename: ${disposition}`,
    );
    assertSmoke(download.body, "Backup download returned no body");
    await pipeline(
        Readable.from(download.body),
        fsSync.createWriteStream(archivePath),
    );
    const sizeBytes = (await fs.stat(archivePath)).size;
    assertSmoke(
        sizeBytes > 100,
        `Backup was unexpectedly small: ${sizeBytes} bytes`,
    );
    const second = await fetchBounded(`${baseUrl}/api/backup/download`, {
        headers: { Cookie: cookie },
    });
    assertSmoke(
        second.status === 401,
        `Second backup download returned ${second.status}`,
    );
    return sizeBytes;
}

export async function uploadArchive(
    baseUrl: string,
    archivePath: string,
    sizeBytes: number,
): Promise<string> {
    const created = await expectJson(
        await fetchBounded(`${baseUrl}/api/restore/uploads`, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ sizeBytes }),
        }),
        201,
    );
    assertSmoke(
        typeof created.uploadId === "string",
        "Upload creation omitted uploadId",
    );
    assertSmoke(
        typeof created.chunkSizeBytes === "number",
        "Upload creation omitted chunk size",
    );
    assertSmoke(
        typeof created.totalChunks === "number" &&
            created.totalChunks <= MAX_UPLOAD_CHUNKS,
        "Upload chunk count is invalid",
    );
    const handle = await fs.open(archivePath, "r");
    try {
        for (let index = 0; index < created.totalChunks; index += 1) {
            const offset = index * created.chunkSizeBytes;
            const length = Math.min(created.chunkSizeBytes, sizeBytes - offset);
            const bytes = Buffer.alloc(length);
            const result = await handle.read(bytes, 0, length, offset);
            assertSmoke(
                result.bytesRead === length,
                `Could not read upload chunk ${index}`,
            );
            const response = await fetchBounded(
                `${baseUrl}/api/restore/uploads/${created.uploadId}/chunks/${index}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/octet-stream" },
                    body: bytes,
                },
            );
            assertSmoke(
                response.status === 204,
                `Upload chunk ${index} returned ${response.status}`,
            );
        }
    } finally {
        await handle.close();
    }
    return created.uploadId;
}

export async function startRestore(
    baseUrl: string,
    uploadId: string,
): Promise<void> {
    const endpoint = `${baseUrl}/api/restore/uploads/${uploadId}/complete`;
    const wrong = await expectJson(
        await fetchBounded(endpoint, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ passphrase: "wrong-smoke-passphrase" }),
        }),
        400,
    );
    assertSmoke(
        wrong.code === "BACKUP_PASSPHRASE_INVALID",
        "Wrong passphrase returned the wrong code",
    );
    await expectJson(
        await fetchBounded(endpoint, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ passphrase: BACKUP_PASSPHRASE }),
        }),
        202,
    );
}

export async function waitForRestore(
    baseUrl: string,
): Promise<Record<string, unknown>> {
    const maximumAttempts = 300;
    const deadline = Date.now() + 10 * 60 * 1_000;
    for (
        let attempt = 0;
        attempt < maximumAttempts && Date.now() < deadline;
        attempt += 1
    ) {
        const status = await expectJson(
            await fetchBounded(`${baseUrl}/api/restore/status`),
            200,
        );
        if (status.state === "failed") {
            throw new Error(`Restore failed: ${JSON.stringify(status)}`);
        }
        if (status.state === "complete") return status;
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("Restore did not complete within ten minutes");
}

export function assertRestoreSummary(
    status: Record<string, unknown>,
    expected: { tables: number; rows: number },
): void {
    assertSmoke(
        status.restartRequired === true,
        "Completed restore did not require restart",
    );
    const summary = status.summary;
    assertSmoke(
        summary !== null && typeof summary === "object",
        "Restore summary is missing",
    );
    const values = summary as Record<string, unknown>;
    assertSmoke(
        expected.tables > 0 && values.tables === expected.tables,
        `Restore summary table count was ${String(values.tables)}, expected ${expected.tables}`,
    );
    assertSmoke(
        expected.rows > 0 && values.rows === expected.rows,
        `Restore summary row count was ${String(values.rows)}, expected ${expected.rows}`,
    );
    assertSmoke(
        typeof values.credentialsReencrypted === "number" &&
            values.credentialsReencrypted >= 1,
        "Restore did not re-encrypt a credential",
    );
}

export async function verifyRestartBarrier(
    baseUrl: string,
    token: string,
): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetchBounded(`${baseUrl}/api/playlists`, {
            headers: bearer(token),
        });
        const body = await expectJson(response, 503);
        if (body.code === "RESTART_REQUIRED") return;
        if (attempt === 0 && body.code === "RESTORE_IN_PROGRESS") {
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
            continue;
        }
        throw new Error("Post-restore API was not restart-blocked");
    }
    throw new Error("Post-restore API remained restore-in-progress");
}

export async function loginAndVerify(baseUrl: string): Promise<void> {
    const login = await expectJson(
        await fetchBounded(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({
                username: ADMIN_USERNAME,
                password: ADMIN_PASSWORD,
            }),
        }),
        200,
    );
    assertSmoke(
        typeof login.token === "string",
        "Login did not return a token",
    );
    const playlistsResponse = await fetchBounded(`${baseUrl}/api/playlists`, {
        headers: bearer(login.token),
    });
    const playlists = (await playlistsResponse.json()) as unknown;
    assertSmoke(
        playlistsResponse.status === 200 && Array.isArray(playlists),
        "Restored playlists were not readable",
    );
    assertSmoke(
        playlists.some(
            (playlist) =>
                typeof playlist === "object" &&
                playlist !== null &&
                (playlist as Record<string, unknown>).name === PLAYLIST_NAME,
        ),
        "Restored playlist was not found",
    );
    const settings = await expectJson(
        await fetchBounded(`${baseUrl}/api/system-settings`, {
            headers: bearer(login.token),
        }),
        200,
    );
    assertSmoke(
        settings.lastfmApiKey === ENCRYPTED_SETTING,
        "Encrypted setting did not survive key rotation",
    );
    const restore = await expectJson(
        await fetchBounded(`${baseUrl}/api/restore/status`),
        200,
    );
    assertSmoke(
        restore.available === false,
        "Restore remained available after user restoration",
    );
    assertSmoke(
        restore.restartRequired === false,
        "Restart marker remained active after restart",
    );
}
