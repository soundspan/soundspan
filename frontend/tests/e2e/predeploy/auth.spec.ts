import { test, expect } from "@playwright/test";
import { loginAsTestUser, username, password } from "../fixtures/test-helpers";

test.describe("Authentication", () => {
    test("login with valid credentials redirects to home", async ({ page }) => {
        await page.goto("/login");
        await page.locator("#username").fill(username);
        await page.locator("#password").fill(password);
        await page.getByRole("button", { name: "Sign In" }).click();
        await page.waitForURL(/\/($|\?|home)/);
        await expect(page).not.toHaveURL(/login/);
    });

    test("login with invalid credentials shows error", async ({ page }) => {
        await page.goto("/login");
        await page.locator("#username").fill("invalid-user");
        await page.locator("#password").fill("wrong-password");
        await page.getByRole("button", { name: "Sign In" }).click();
        // Error can be "Invalid credentials" or "Not authenticated"
        await expect(page.locator("text=/Invalid|Not authenticated/i")).toBeVisible({ timeout: 5000 });
    });

    test("protected routes redirect to login when unauthenticated", async ({ page }) => {
        await page.goto("/library");
        await expect(page).toHaveURL(/login/);
    });

    test("logout clears session and redirects to login", async ({ page }) => {
        await loginAsTestUser(page);

        await page.getByRole("button", { name: "User menu" }).click();
        await page.getByRole("button", { name: "Log out" }).click();

        await expect(page).toHaveURL(/login/, { timeout: 5000 });
    });
});
