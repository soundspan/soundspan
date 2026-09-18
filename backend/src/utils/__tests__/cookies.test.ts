import type { Request } from "express";
import { readCookie } from "../cookies";

function requestWithCookie(cookie?: string): Request {
    return {
        headers: cookie === undefined ? {} : { cookie },
    } as Request;
}

describe("readCookie", () => {
    it("returns null when the Cookie header is absent", () => {
        expect(readCookie(requestWithCookie(), "session")).toBeNull();
    });

    it("returns null when the Cookie header exceeds the length bound", () => {
        expect(
            readCookie(
                requestWithCookie(`session=${"x".repeat(4096)}`),
                "session",
            ),
        ).toBeNull();
    });

    it("returns null when the Cookie header exceeds the cookie-count bound", () => {
        const cookies = Array.from(
            { length: 65 },
            (_, index) => `cookie-${index}=value`,
        );
        cookies[0] = "session=credential";

        expect(
            readCookie(requestWithCookie(cookies.join("; ")), "session"),
        ).toBeNull();
    });

    it("matches only the exact cookie name", () => {
        expect(
            readCookie(
                requestWithCookie("soundspan-queues-extra=wrong"),
                "soundspan-queues",
            ),
        ).toBeNull();
    });

    it("preserves equals signs in the cookie value", () => {
        expect(
            readCookie(requestWithCookie("session=part=two="), "session"),
        ).toBe("part=two=");
    });
});
