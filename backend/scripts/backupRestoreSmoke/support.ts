import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 30_000;

export interface BackendProcess {
    child: ChildProcess;
    logPath: string;
    startupError: Error | null;
}

export function assertSmoke(
    condition: unknown,
    message: string,
): asserts condition {
    if (!condition) throw new Error(message);
}

export function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

export function randomSecret(): string {
    return crypto.randomBytes(32).toString("hex");
}

export function redisDatabaseUrl(baseUrl: string, database: number): string {
    const value = new URL(baseUrl);
    value.pathname = `/${database}`;
    return value.toString();
}

async function waitForExit(
    child: ChildProcess,
    timeoutMs: number,
): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolve) => {
        const onClose = (): void => {
            clearTimeout(timeout);
            resolve(true);
        };
        const timeout = setTimeout(() => {
            child.off("close", onClose);
            resolve(false);
        }, timeoutMs);
        child.once("close", onClose);
    });
}

export async function runCommand(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<void> {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let spawnError: Error | null = null;
    const append = (chunk: Buffer): void => {
        output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => {
        spawnError = error;
    });
    try {
        const exited = await waitForExit(child, options.timeoutMs);
        if (!exited) throw new Error(`${command} timed out`);
        if (spawnError) throw spawnError;
        if (child.exitCode !== 0) {
            throw new Error(
                `${command} failed with exit ${child.exitCode}\n${output}`,
            );
        }
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await waitForExit(child, 5_000);
        }
    }
}

export function startBackend(
    backendRoot: string,
    env: NodeJS.ProcessEnv,
    logPath: string,
): BackendProcess {
    const logFd = fsSync.openSync(logPath, "a", 0o600);
    try {
        const child = spawn(process.execPath, ["dist/index.js"], {
            cwd: backendRoot,
            env,
            shell: false,
            stdio: ["ignore", logFd, logFd],
        });
        const backend: BackendProcess = {
            child,
            logPath,
            startupError: null,
        };
        child.once("error", (error) => {
            backend.startupError = error;
        });
        return backend;
    } finally {
        fsSync.closeSync(logFd);
    }
}

export async function stopBackend(
    backend: BackendProcess | null,
): Promise<void> {
    if (!backend) return;
    if (backend.child.exitCode !== null || backend.child.signalCode !== null) {
        return;
    }
    backend.child.kill("SIGTERM");
    if (await waitForExit(backend.child, 30_000)) return;
    backend.child.kill("SIGKILL");
    await waitForExit(backend.child, 5_000);
}

export async function fetchBounded(
    input: string,
    init: RequestInit = {},
): Promise<Response> {
    return await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

export async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error(
            `Expected JSON from ${response.url}: ${text.slice(0, 500)}`,
        );
    }
}

export async function expectJson(
    response: Response,
    expectedStatus: number,
): Promise<Record<string, unknown>> {
    const body = await readJson(response);
    assertSmoke(
        response.status === expectedStatus,
        `${response.url} returned ${response.status}, expected ${expectedStatus}: ${JSON.stringify(body)}`,
    );
    assertSmoke(
        body !== null && typeof body === "object",
        `${response.url} returned no JSON object`,
    );
    return body as Record<string, unknown>;
}

export async function waitForReady(
    baseUrl: string,
    backend: BackendProcess,
): Promise<void> {
    const deadline = Date.now() + 3 * 60 * 1_000;
    const maximumAttempts = 180;
    for (
        let attempt = 0;
        attempt < maximumAttempts && Date.now() < deadline;
        attempt += 1
    ) {
        if (backend.startupError) throw backend.startupError;
        if (backend.child.exitCode !== null) {
            throw new Error(
                `Backend exited before readiness with code ${backend.child.exitCode}`,
            );
        }
        try {
            const response = await fetchBounded(`${baseUrl}/health/ready`);
            if (response.status === 200) return;
        } catch {
            // Startup connection refusals are expected until the listener binds.
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Backend did not become ready at ${baseUrl}`);
}

export function bearer(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
}

export async function printLogTail(logPath: string): Promise<void> {
    const text = await fs.readFile(logPath, "utf8").catch(() => "");
    const tail = text.split(/\r?\n/).slice(-100).join("\n");
    process.stderr.write(
        `\n--- ${path.basename(logPath)} (last 100 lines) ---\n${tail}\n`,
    );
}
