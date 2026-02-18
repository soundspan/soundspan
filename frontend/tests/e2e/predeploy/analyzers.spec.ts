import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

test.describe("Analyzers", () => {
    test("app loads with analyzer detection working", async ({ page }) => {
        await loginAsTestUser(page);
        await page.goto("/");

        // The app should load properly - if feature detection fails, the app would error
        await expect(page.locator("body")).toBeVisible();

        // Should see the main navigation
        await expect(page.locator("text=Library")).toBeVisible({ timeout: 5000 });
    });

    test("library shows content (requires working backend)", async ({ page }) => {
        await loginAsTestUser(page);
        await page.goto("/library?tab=albums");

        // If analyzers/backend are broken, library would be empty or error
        const albumLinks = page.locator('a[href^="/album/"]');
        await expect(albumLinks.first()).toBeVisible({ timeout: 10000 });
    });
});
