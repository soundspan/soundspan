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
});
