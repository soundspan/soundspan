import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

test.describe("Playback", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("home page shows player area", async ({ page }) => {
        await page.goto("/");

        // Should show "Not Playing" or similar player status
        await expect(page.locator("text=/Not Playing|Now Playing|Select something/i").first()).toBeVisible({ timeout: 5000 });
    });

    test("album page accessible and shows tracks", async ({ page }) => {
        await page.goto("/library?tab=albums");

        // Wait for albums to load
        const firstAlbum = page.locator('a[href^="/album/"]').first();
        await expect(firstAlbum).toBeVisible({ timeout: 10000 });
        await firstAlbum.click();

        // Should be on album page with track list
        await expect(page).toHaveURL(/\/album\//);
    });

    test("queue page accessible", async ({ page }) => {
        await page.goto("/queue");

        // Should load without error
        await expect(page.locator("body")).toBeVisible();
        await expect(page).toHaveURL(/queue/);
    });

    test("overlay Up Next keeps current queue row centered after tab switch", async ({
        page,
    }) => {
        await page.goto("/library");

        await page.locator('button[title="Shuffle Library"]').click();

        const openOverlayButton = page.getByRole("button", {
            name: "Open overlay player",
        });
        await expect(openOverlayButton).toBeEnabled({ timeout: 20000 });

        // Move away from queue index 0 so the centering assertion can detect regressions.
        const nextTrackButton = page.getByRole("button", { name: "Next track" });
        for (let i = 0; i < 5; i += 1) {
            if (!(await nextTrackButton.isEnabled())) break;
            await nextTrackButton.click();
            await page.waitForTimeout(120);
        }

        await openOverlayButton.click();

        const upNextTab = page.getByRole("button", {
            name: "Up Next",
            exact: true,
        });
        const lyricsTab = page.getByRole("button", {
            name: "Lyrics",
            exact: true,
        });

        await upNextTab.click();
        await expect(page.locator('[data-queue-index="0"]')).toBeVisible({
            timeout: 10000,
        });

        const currentQueueRow = page
            .locator("[data-queue-index]")
            .filter({ has: page.locator('button[title="Now playing"]') })
            .first();
        await expect(currentQueueRow).toBeVisible({ timeout: 10000 });

        await lyricsTab.click();
        await upNextTab.click();

        const queueSize = await page.locator("[data-queue-index]").count();
        test.skip(
            queueSize <= 8,
            `Need at least 9 queue rows to validate centering, found ${queueSize}`
        );

        const getQueueAlignment = async () =>
            currentQueueRow.evaluate((row) => {
                const container = row.parentElement as HTMLElement | null;
                if (!container) return null;

                const rowRect = row.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const rowTop = rowRect.top - containerRect.top;
                const rowCenter = rowTop + rowRect.height / 2;
                const containerMid = container.clientHeight / 2;

                return {
                    centerDelta: Math.abs(rowCenter - containerMid),
                    centerTolerance: Math.max(56, container.clientHeight * 0.24),
                    rowTop,
                    minTopOffset: Math.max(20, rowRect.height * 0.6),
                };
            });

        await expect
            .poll(
                async () => {
                    const alignment = await getQueueAlignment();
                    if (!alignment) return Number.POSITIVE_INFINITY;
                    return alignment.centerDelta - alignment.centerTolerance;
                },
                { timeout: 8000 }
            )
            .toBeLessThanOrEqual(0);

        await expect
            .poll(
                async () => {
                    const alignment = await getQueueAlignment();
                    if (!alignment) return Number.NEGATIVE_INFINITY;
                    return alignment.rowTop - alignment.minTopOffset;
                },
                { timeout: 8000 }
            )
            .toBeGreaterThanOrEqual(0);
    });
});
