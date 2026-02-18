import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "../fixtures/test-helpers";

test.describe("Listen Together", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("listen together page loads lobby controls", async ({ page }) => {
        await page.goto("/listen-together");

        await expect(
            page.getByRole("heading", { name: /listen together/i })
        ).toBeVisible();
        await expect(page.getByText("Create a Group")).toBeVisible({
            timeout: 10000,
        });
    });

    test("socket route probe path is not front-end HTML fallback", async ({
        page,
    }) => {
        const response = await page.request.get(
            "/socket.io/listen-together/?EIO=4&transport=polling&t=predeploy"
        );
        const bodyPrefix = (await response.text()).trim().slice(0, 120);
        const contentType =
            response.headers()["content-type"]?.toLowerCase() ?? "";
        const isHtmlFallback =
            contentType.includes("text/html") ||
            /^<!doctype html|^<html/i.test(bodyPrefix);

        // Socket endpoint should return Socket.IO payload/error, not front-end HTML.
        expect(isHtmlFallback).toBeFalsy();
        expect([200, 400]).toContain(response.status());
    });
});
