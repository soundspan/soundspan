import { test, expect, APIResponse } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

interface TrackListResponse {
    tracks?: Array<{ id?: string }>;
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

test.describe("Media Contract", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("direct media path satisfies range/cors/content-type contracts", async ({
        page,
        baseURL,
    }) => {
        test.skip(!baseURL, "Skipping: Playwright baseURL is required");
        if (!baseURL) return;

        const requestOrigin = new URL(baseURL).origin;
        const tracksResponse = await page.request.get(
            "/api/library/tracks?limit=1",
        );
        expect(tracksResponse.ok()).toBeTruthy();

        const tracksPayload =
            (await tracksResponse.json()) as TrackListResponse;
        const trackId = tracksPayload.tracks?.[0]?.id;
        test.skip(
            !trackId,
            "Skipping: no library tracks available for media contract checks",
        );
        if (!trackId) return;

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

        const directContentType = readHeader(
            directStreamResponse,
            "content-type",
        );
        expect(directContentType).toBeTruthy();
        expect(directContentType.toLowerCase()).not.toContain("text/html");
        expect(directContentType.toLowerCase()).not.toContain(
            "application/json",
        );

        if (
            /(^|;)\s*(audio|video)\/mp4\b|(^|;)\s*audio\/x-m4a\b/i.test(
                directContentType,
            )
        ) {
            const mp4ProbeBytes = await directStreamResponse.body();
            const moovOffset = mp4ProbeBytes.indexOf(Buffer.from("moov"));
            expect(
                moovOffset >= 0,
                "Expected MP4 stream head to include a moov atom for fast-start compatibility",
            ).toBeTruthy();
        }

        // Removed with segmented streaming (issue #534): the session surface
        // must be gone, not silently half-alive.
        const removedSessionResponse = await page.request.post(
            "/api/streaming/v1/sessions",
            {
                data: {
                    trackId,
                    sourceType: "local",
                },
            },
        );
        expect(removedSessionResponse.status()).toBe(404);
    });
});
