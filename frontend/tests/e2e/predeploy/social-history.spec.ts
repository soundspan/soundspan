import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

test.describe("Social and History", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("activity panel social tab renders", async ({ page }) => {
        await page.goto("/");

        const toggle = page
            .getByRole("button", { name: /toggle activity panel/i })
            .first();
        const hasToggle = await toggle.isVisible({ timeout: 2000 }).catch(
            () => false
        );
        if (hasToggle) {
            await toggle.click();
        } else {
            await page.evaluate(() => {
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
            });
        }

        const socialTab = page.getByRole("button", { name: /social/i }).first();
        await expect(socialTab).toBeVisible({ timeout: 5000 });
        await socialTab.click();

        await expect(page.getByText("Activity").first()).toBeVisible({
            timeout: 5000,
        });
        await expect(socialTab).toHaveClass(/border-b-2/, { timeout: 5000 });
    });

    test("my history page loads and shows queue-style actions", async ({
        page,
    }) => {
        await page.goto("/my-history");

        await expect(
            page.getByRole("heading", { name: /my history/i })
        ).toBeVisible({ timeout: 10000 });

        const emptyState = page.getByText("No listening history yet");
        const playNowButton = page
            .getByRole("button", { name: "Play now" })
            .first();

        const resolvedState = await Promise.race([
            emptyState
                .waitFor({ state: "visible", timeout: 10000 })
                .then(() => "empty" as const),
            playNowButton
                .waitFor({ state: "visible", timeout: 10000 })
                .then(() => "actions" as const),
        ]);

        if (resolvedState === "empty") {
            await expect(emptyState).toBeVisible();
            return;
        }

        await expect(playNowButton).toBeVisible({ timeout: 5000 });
        await expect(
            page.getByRole("button", { name: "Add to queue" }).first()
        ).toBeVisible({ timeout: 5000 });
        await expect(
            page.getByRole("button", { name: "Add to playlist" }).first()
        ).toBeVisible({ timeout: 5000 });
    });

    test("settings social controls are visible", async ({ page }) => {
        await page.goto("/settings");

        await expect(
            page.locator("text=Share online presence").first()
        ).toBeVisible({ timeout: 10000 });
        await expect(
            page.locator("text=Share listening status").first()
        ).toBeVisible({ timeout: 10000 });
    });

    test("my history is accessed from settings, not sidebar navigation", async ({
        page,
    }) => {
        await page.goto("/");

        const mainNav = page.getByRole("navigation", {
            name: /main navigation/i,
        });
        await expect(
            mainNav.getByRole("link", { name: /my history/i })
        ).toHaveCount(0);

        await page.goto("/settings");
        await expect(
            page.getByRole("link", { name: /open my history/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test("non-admin users do not see download tabs in activity panel", async ({
        page,
    }) => {
        await page.goto("/");

        const toggle = page
            .getByRole("button", { name: /toggle activity panel/i })
            .first();
        const hasToggle = await toggle.isVisible({ timeout: 2000 }).catch(
            () => false
        );
        if (hasToggle) {
            await toggle.click();
        } else {
            await page.evaluate(() => {
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
            });
        }

        await expect(
            page.getByRole("button", { name: /^notifications$/i })
        ).toBeVisible({ timeout: 5000 });
        await expect(
            page.getByRole("button", { name: /^social$/i })
        ).toBeVisible({ timeout: 5000 });
        await expect(
            page.getByRole("button", { name: /^active$/i })
        ).toHaveCount(0);
        await expect(
            page.getByRole("button", { name: /^history$/i })
        ).toHaveCount(0);
    });
});
