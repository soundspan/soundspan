import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

test.describe("Library", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("home page loads with library stats", async ({ page }) => {
        await page.goto("/");
        // Should show some indication of library content
        await expect(page.locator("body")).toContainText(/artist|album|track|library/i);
    });

    test("albums tab shows album grid", async ({ page }) => {
        await page.goto("/library?tab=albums");
        await expect(page.getByRole("heading", { name: /library/i })).toBeVisible();

        // Should have at least one album link
        const albumLinks = page.locator('a[href^="/album/"]');
        await expect(albumLinks.first()).toBeVisible({ timeout: 10000 });
    });

    test("artists tab shows artist list", async ({ page }) => {
        await page.goto("/library?tab=artists");
        await expect(page.getByRole("heading", { name: /library/i })).toBeVisible();

        // Should have at least one artist link
        const artistLinks = page.locator('a[href^="/artist/"]');
        await expect(artistLinks.first()).toBeVisible({ timeout: 10000 });
    });

    test("tracks tab shows track list", async ({ page }) => {
        await page.goto("/library?tab=tracks");
        await expect(page.getByRole("heading", { name: /library/i })).toBeVisible();

        // Should have at least one track in the list
        const trackRows = page.locator('[data-track-id], [class*="track"]');
        await expect(trackRows.first()).toBeVisible({ timeout: 10000 });
    });

    test("search page accessible", async ({ page }) => {
        await page.goto("/search");

        // Search page should load
        await expect(page.locator("body")).toBeVisible();
        await expect(page).toHaveURL(/search/);
    });
});
