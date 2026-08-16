import assert from "node:assert/strict";
import configModule from "next/dist/server/config.js";
import { PHASE_PRODUCTION_SERVER } from "next/constants.js";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";

const loadConfig = configModule.default;

const config = await loadConfig(PHASE_PRODUCTION_SERVER, process.cwd());

assert.equal(config.images.dangerouslyAllowSVG, true);
assert.equal(config.images.contentDispositionType, "attachment");
assert.equal(
    config.images.contentSecurityPolicy,
    "default-src 'self'; script-src 'none'; frame-src 'none'; sandbox;",
);

const originalEnvironment = {
    CSP_ENFORCE: process.env.CSP_ENFORCE,
    CSP_REPORT_URI: process.env.CSP_REPORT_URI,
    NODE_ENV: process.env.NODE_ENV,
};

function restoreEnvironment() {
    for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

function getNonce(policy) {
    const match = policy.match(/'nonce-([^']+)'/);
    assert.ok(match, "script-src must contain a nonce");
    return match[1];
}

function requestPage(pathname) {
    return proxy(new NextRequest(`https://soundspan.test${pathname}`));
}

try {
    process.env.NODE_ENV = "production";
    delete process.env.CSP_ENFORCE;
    delete process.env.CSP_REPORT_URI;

    const firstReportOnly = requestPage("/");
    const secondReportOnly = requestPage("/share/public-token");
    const reportOnlyPolicy = firstReportOnly.headers.get(
        "Content-Security-Policy-Report-Only",
    );
    const secondReportOnlyPolicy = secondReportOnly.headers.get(
        "Content-Security-Policy-Report-Only",
    );

    assert.ok(reportOnlyPolicy);
    assert.ok(secondReportOnlyPolicy);
    assert.equal(firstReportOnly.headers.get("Content-Security-Policy"), null);
    const firstNonce = getNonce(reportOnlyPolicy);
    assert.notEqual(firstNonce, getNonce(secondReportOnlyPolicy));
    assert.equal(
        firstReportOnly.headers.get(
            "x-middleware-request-content-security-policy-report-only",
        ),
        reportOnlyPolicy,
    );
    assert.equal(
        firstReportOnly.headers.get("x-middleware-request-x-nonce"),
        firstNonce,
    );
    assert.equal(
        reportOnlyPolicy.replace(/'nonce-[^']+'/u, "'nonce-{NONCE}'"),
        "default-src 'self'; script-src 'self' 'nonce-{NONCE}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );

    process.env.CSP_ENFORCE = "true";
    const enforcing = requestPage("/");
    assert.ok(enforcing.headers.get("Content-Security-Policy"));
    assert.equal(
        enforcing.headers.get("Content-Security-Policy-Report-Only"),
        null,
    );

    process.env.CSP_REPORT_URI = "/api/security/csp-reports";
    const reporting = requestPage("/");
    assert.match(
        reporting.headers.get("Content-Security-Policy") ?? "",
        /; report-uri \/api\/security\/csp-reports; report-to csp-endpoint$/,
    );
    assert.equal(
        reporting.headers.get("Reporting-Endpoints"),
        'csp-endpoint="/api/security/csp-reports"',
    );

    process.env.CSP_REPORT_URI = "/safe; script-src *";
    const invalidReporting = requestPage("/");
    assert.doesNotMatch(
        invalidReporting.headers.get("Content-Security-Policy") ?? "",
        /report-uri|script-src \*/,
    );
    assert.equal(invalidReporting.headers.get("Reporting-Endpoints"), null);
} finally {
    restoreEnvironment();
}
