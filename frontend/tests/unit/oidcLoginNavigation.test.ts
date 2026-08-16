import assert from "node:assert/strict";
import test from "node:test";
import {
    buildOidcLoginUrl,
    normalizeLoginReturnTo,
} from "../../features/auth/oidc";

test("normalizeLoginReturnTo preserves same-origin relative destinations", () => {
    assert.equal(normalizeLoginReturnTo("/"), "/");
    assert.equal(
        normalizeLoginReturnTo("/library?tab=albums#recent"),
        "/library?tab=albums#recent",
    );
});

test("normalizeLoginReturnTo rejects open-redirect and malformed destinations", () => {
    const rejected = [
        null,
        "",
        "library",
        "https://evil.example/steal",
        "//evil.example/steal",
        "/\\evil.example/steal",
        "javascript:alert(1)",
    ];

    for (const value of rejected) {
        assert.equal(normalizeLoginReturnTo(value), "/");
    }
});

test("buildOidcLoginUrl uses the configured direct API base and encoded returnTo", () => {
    const result = buildOidcLoginUrl("/library?tab=albums", {
        configuredApiUrl: "https://api.soundspan.test/",
        apiPathMode: "direct",
        browserLocation: {
            protocol: "https:",
            hostname: "music.soundspan.test",
            port: "",
        },
    });

    assert.equal(
        result,
        "https://api.soundspan.test/api/auth/oidc/login?returnTo=%2Flibrary%3Ftab%3Dalbums",
    );
});
