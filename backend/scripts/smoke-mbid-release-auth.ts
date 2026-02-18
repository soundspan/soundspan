import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

type JsonRecord = Record<string, unknown>;

const backendBaseUrl = (process.env.BACKEND_BASE_URL ?? "http://127.0.0.1:3006").replace(/\/+$/, "");
const frontendBaseUrl = (process.env.FRONTEND_BASE_URL ?? "http://127.0.0.1:3030").replace(/\/+$/, "");
const testUsername = process.env.SOUNDSPAN_TEST_USERNAME ?? "predeploy";
const testPassword = process.env.SOUNDSPAN_TEST_PASSWORD ?? "predeploy-password";
const bootstrapUser = process.env.SMOKE_BOOTSTRAP_USER !== "false";

function assertCondition(condition: unknown, message: string): asserts condition {
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

function asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

async function requestJson(
    url: string,
    options?: {
        method?: "GET" | "POST";
        token?: string;
        body?: JsonRecord;
    },
): Promise<{ status: number; body: JsonRecord }> {
    const response = await fetch(url, {
        method: options?.method ?? "GET",
        headers: {
            "Content-Type": "application/json",
            ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    const body = (await response.json()) as JsonRecord;
    return { status: response.status, body };
}

async function ensureTestUserReady(): Promise<void> {
    if (!bootstrapUser) {
        return;
    }

    const databaseUrl = process.env.DATABASE_URL;
    assertCondition(
        databaseUrl && databaseUrl.length > 0,
        "DATABASE_URL is required when SMOKE_BOOTSTRAP_USER is enabled",
    );

    const prisma = new PrismaClient();
    try {
        const passwordHash = await bcrypt.hash(testPassword, 10);
        await prisma.user.upsert({
            where: { username: testUsername },
            update: {
                passwordHash,
                onboardingComplete: true,
            },
            create: {
                username: testUsername,
                passwordHash,
                onboardingComplete: true,
            },
        });
        console.log(`smoke: test user ready (${testUsername})`);
    } finally {
        await prisma.$disconnect();
    }
}

async function loginForToken(baseUrl: string): Promise<string> {
    const { status, body } = await requestJson(`${baseUrl}/api/auth/login`, {
        method: "POST",
        body: {
            username: testUsername,
            password: testPassword,
        },
    });

    assertCondition(status === 200, `login failed (${status}): ${JSON.stringify(body)}`);
    assertCondition(
        body.requires2FA !== true,
        "smoke user requires 2FA; disable 2FA for deterministic smoke checks",
    );

    const token = asString(body.token);
    assertCondition(token, `login response missing token: ${JSON.stringify(body)}`);
    return token;
}

function assertStatusAndError(
    label: string,
    result: { status: number; body: JsonRecord },
    expectedStatus: number,
    expectedError: string,
): void {
    assertCondition(
        result.status === expectedStatus,
        `${label}: expected HTTP ${expectedStatus}, got ${result.status} body=${JSON.stringify(result.body)}`,
    );
    assertCondition(
        result.body.error === expectedError,
        `${label}: expected error=\"${expectedError}\", got body=${JSON.stringify(result.body)}`,
    );
}

async function runSurfaceMatrix(
    label: "backend-direct" | "frontend-proxied",
    baseUrl: string,
    token: string,
): Promise<void> {
    // 1) Lookup endpoint must be auth-gated
    const unauthArtistLookup = await requestJson(
        `${baseUrl}/api/enrichment/search/musicbrainz/artists?q=radiohead`,
    );
    assertStatusAndError(
        `${label} unauth artists lookup`,
        unauthArtistLookup,
        401,
        "Not authenticated",
    );

    // 2) Authenticated lookup validation contract
    const authArtistLookupShortQuery = await requestJson(
        `${baseUrl}/api/enrichment/search/musicbrainz/artists?q=r`,
        { token },
    );
    assertStatusAndError(
        `${label} auth artists short query`,
        authArtistLookupShortQuery,
        400,
        "Query must be at least 2 characters",
    );

    const authReleaseGroupLookupShortQuery = await requestJson(
        `${baseUrl}/api/enrichment/search/musicbrainz/release-groups?q=o&artist=Radiohead`,
        { token },
    );
    assertStatusAndError(
        `${label} auth release-group short query`,
        authReleaseGroupLookupShortQuery,
        400,
        "Query must be at least 2 characters",
    );

    // 3) Interactive releases endpoint auth/contract checks
    const releasePath =
        "/api/downloads/releases/6d751a3f-4b2f-4d79-b006-18f6f5f43f33?artistName=Radiohead&albumTitle=OK%20Computer";

    const unauthReleases = await requestJson(`${baseUrl}${releasePath}`);
    assertStatusAndError(
        `${label} unauth interactive releases`,
        unauthReleases,
        401,
        "Not authenticated",
    );

    const authReleases = await requestJson(`${baseUrl}${releasePath}`, { token });
    assertCondition(
        authReleases.status === 400 ||
            authReleases.status === 404 ||
            authReleases.status === 200,
        `${label} auth interactive releases unexpected status ${authReleases.status}: ${JSON.stringify(authReleases.body)}`,
    );
    if (authReleases.status === 400) {
        assertCondition(
            authReleases.body.error === "Lidarr not configured",
            `${label} auth interactive releases (400) unexpected body: ${JSON.stringify(authReleases.body)}`,
        );
    }
    if (authReleases.status === 404) {
        assertCondition(
            authReleases.body.error === "Album not found in Lidarr",
            `${label} auth interactive releases (404) unexpected body: ${JSON.stringify(authReleases.body)}`,
        );
    }
    if (authReleases.status === 200) {
        assertCondition(
            typeof authReleases.body.total === "number" && Array.isArray(authReleases.body.releases),
            `${label} auth interactive releases (200) missing expected payload fields: ${JSON.stringify(authReleases.body)}`,
        );
    }

    // 4) Interactive grab endpoint auth + deterministic payload validation
    const unauthGrab = await requestJson(`${baseUrl}/api/downloads/grab`, {
        method: "POST",
        body: {
            guid: "g1",
            lidarrAlbumId: 1,
        },
    });
    assertStatusAndError(
        `${label} unauth interactive grab`,
        unauthGrab,
        401,
        "Not authenticated",
    );

    const authGrabMissingFields = await requestJson(`${baseUrl}/api/downloads/grab`, {
        method: "POST",
        token,
        body: {
            albumMbid: "rg-1",
        },
    });
    assertStatusAndError(
        `${label} auth interactive grab missing-fields`,
        authGrabMissingFields,
        400,
        "Missing required fields: guid, lidarrAlbumId",
    );

    console.log(`smoke: ${label} matrix passed`);
}

async function main(): Promise<void> {
    await ensureTestUserReady();
    const token = await loginForToken(backendBaseUrl);

    await runSurfaceMatrix("backend-direct", backendBaseUrl, token);
    await runSurfaceMatrix("frontend-proxied", frontendBaseUrl, token);

    console.log("smoke: mbid authenticated verification passed");
}

main().catch((error) => {
    console.error("smoke: mbid authenticated verification failed", error);
    process.exitCode = 1;
});
