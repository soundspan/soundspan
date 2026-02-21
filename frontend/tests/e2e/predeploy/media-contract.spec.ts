import { test, expect, APIResponse } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

interface TrackListResponse {
    tracks?: Array<{ id?: string }>;
}

interface SegmentedSessionCreateResponse {
    sessionId?: string;
    manifestUrl?: string;
    sessionToken?: string;
}

function readHeader(response: APIResponse, name: string): string {
    const value = response.headers()[name.toLowerCase()];
    return typeof value === "string" ? value : "";
}

function expectCorsHeader(response: APIResponse, requestOrigin: string): void {
    const allowedOrigin = readHeader(response, "access-control-allow-origin");
    expect(
        allowedOrigin === requestOrigin || allowedOrigin === "*",
        `Expected Access-Control-Allow-Origin to be '${requestOrigin}' or '*', got '${allowedOrigin || "<missing>"}'`,
    ).toBeTruthy();
}

function resolveInitSegmentName(manifestBody: string): string {
    const initializationMatch = manifestBody.match(/initialization="([^"]+)"/i);
    if (!initializationMatch) {
        return "";
    }

    const representationMatch = manifestBody.match(
        /<Representation[^>]*\sid="([^"]+)"/i,
    );
    const representationId = representationMatch?.[1] ?? "0";

    return initializationMatch[1]
        .replace(/\$RepresentationID\$/g, representationId)
        .replace(/\$Bandwidth\$/g, "0")
        .replace(/\$Number%0(\d+)d\$/g, (_match, width: string) =>
            String(1).padStart(Number.parseInt(width, 10), "0"),
        )
        .replace(/\$Number\$/g, "1");
}

test.describe("Media Contract", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("direct and segmented media paths satisfy range/cors/content-type contracts", async ({
        page,
        baseURL,
    }) => {
        test.skip(!baseURL, "Skipping: Playwright baseURL is required");

        const requestOrigin = new URL(baseURL).origin;
        const tracksResponse = await page.request.get("/api/library/tracks?limit=1");
        expect(tracksResponse.ok()).toBeTruthy();

        const tracksPayload =
            (await tracksResponse.json()) as TrackListResponse;
        const trackId = tracksPayload.tracks?.[0]?.id;
        test.skip(!trackId, "Skipping: no library tracks available for media contract checks");

        const directStreamResponse = await page.request.get(
            `/api/library/tracks/${encodeURIComponent(trackId)}/stream?quality=original`,
            {
                headers: {
                    Range: "bytes=0-262143",
                    Origin: requestOrigin,
                },
            },
        );

        expect(directStreamResponse.status()).toBe(206);
        expect(readHeader(directStreamResponse, "accept-ranges")).toContain(
            "bytes",
        );
        expect(readHeader(directStreamResponse, "content-range")).toMatch(
            /^bytes\s+\d+-\d+\/\d+$/i,
        );
        expectCorsHeader(directStreamResponse, requestOrigin);

        const directContentType = readHeader(directStreamResponse, "content-type");
        expect(directContentType).toBeTruthy();
        expect(directContentType.toLowerCase()).not.toContain("text/html");
        expect(directContentType.toLowerCase()).not.toContain("application/json");

        if (/(^|;)\s*(audio|video)\/mp4\b|(^|;)\s*audio\/x-m4a\b/i.test(directContentType)) {
            const mp4ProbeBytes = await directStreamResponse.body();
            const moovOffset = mp4ProbeBytes.indexOf(Buffer.from("moov"));
            expect(
                moovOffset >= 0,
                "Expected MP4 stream head to include a moov atom for fast-start compatibility",
            ).toBeTruthy();
        }

        const createSessionResponse = await page.request.post(
            "/api/streaming/v1/sessions",
            {
                data: {
                    trackId,
                    sourceType: "local",
                    desiredQuality: "medium",
                },
            },
        );

        expect(createSessionResponse.status()).toBe(201);
        const segmentedSession =
            (await createSessionResponse.json()) as SegmentedSessionCreateResponse;
        expect(segmentedSession.manifestUrl).toBeTruthy();
        expect(segmentedSession.sessionToken).toBeTruthy();

        const manifestResponse = await page.request.get(
            segmentedSession.manifestUrl!,
            {
                headers: {
                    Origin: requestOrigin,
                },
            },
        );

        expect(manifestResponse.status()).toBe(200);
        expectCorsHeader(manifestResponse, requestOrigin);
        expect(readHeader(manifestResponse, "content-type").toLowerCase()).toContain(
            "application/dash+xml",
        );

        const manifestBody = await manifestResponse.text();
        const initSegmentName = resolveInitSegmentName(manifestBody);
        expect(
            initSegmentName,
            "Expected DASH manifest to provide an initialization segment template",
        ).toBeTruthy();

        const manifestUrl = new URL(segmentedSession.manifestUrl!, baseURL);
        const initSegmentUrl = new URL(initSegmentName, manifestUrl);

        const segmentResponse = await page.request.get(initSegmentUrl.toString(), {
            headers: {
                Range: "bytes=0-63",
                Origin: requestOrigin,
                "x-streaming-session-token": segmentedSession.sessionToken!,
            },
        });

        expect(segmentResponse.status()).toBe(206);
        expect(readHeader(segmentResponse, "accept-ranges")).toContain("bytes");
        expect(readHeader(segmentResponse, "content-range")).toMatch(
            /^bytes\s+\d+-\d+\/\d+$/i,
        );
        expectCorsHeader(segmentResponse, requestOrigin);
        expect(readHeader(segmentResponse, "content-type").toLowerCase()).toContain(
            "video/iso.segment",
        );
    });
});
