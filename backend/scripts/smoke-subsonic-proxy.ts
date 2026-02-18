type JsonRecord = Record<string, unknown>;

const backendBaseUrl = process.env.BACKEND_BASE_URL ?? "http://127.0.0.1:3006";
const frontendBaseUrl = process.env.FRONTEND_BASE_URL ?? "http://127.0.0.1:3030";

function assertCondition(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

function asRecord(value: unknown): JsonRecord | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as JsonRecord;
}

async function fetchJson(url: string): Promise<JsonRecord> {
    const response = await fetch(url);
    const body = (await response.json()) as JsonRecord;

    assertCondition(
        response.ok,
        `HTTP ${response.status} for ${url}: ${JSON.stringify(body)}`,
    );

    return body;
}

async function checkSubsonicEnvelope(baseUrl: string, label: string): Promise<void> {
    const url = new URL("/rest/ping.view", baseUrl);
    url.searchParams.set("f", "json");

    const payload = await fetchJson(url.toString());
    const envelope = asRecord(payload["subsonic-response"]);
    assertCondition(envelope, `${label} missing subsonic-response envelope`);

    console.log(`smoke: ${label} ok`);
}

async function main(): Promise<void> {
    await checkSubsonicEnvelope(backendBaseUrl, "backend-direct");
    await checkSubsonicEnvelope(frontendBaseUrl, "frontend-proxied");
    console.log("smoke: subsonic proxy check passed");
}

main().catch((error) => {
    console.error("smoke: subsonic proxy check failed", error);
    process.exitCode = 1;
});
