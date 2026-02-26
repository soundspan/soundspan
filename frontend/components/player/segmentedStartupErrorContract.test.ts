import assert from "node:assert/strict";
import test from "node:test";
import {
    parseSegmentedStartupErrorHint,
    resolveConservativeSegmentedStartupRetryDelayMs,
} from "./segmentedStartupErrorContract.ts";

test("parseSegmentedStartupErrorHint reads structured hint from API error data", () => {
    const error = Object.assign(new Error("Manifest not ready"), {
        status: 503,
        data: {
            error: "Manifest startup window is still being prepared",
            code: "STREAMING_ASSET_NOT_READY",
            segmentedStartupRetryHint: {
                isTransient: true,
                retryAfterMs: 1800,
            },
        },
    });

    const hint = parseSegmentedStartupErrorHint(error);
    assert.deepEqual(hint, {
        isTransient: true,
        retryAfterMs: 1800,
        code: "STREAMING_ASSET_NOT_READY",
        statusCode: 503,
    });
});

test("parseSegmentedStartupErrorHint accepts nested snake_case hint fields", () => {
    const error = Object.assign(new Error("asset build failed"), {
        status: 502,
        data: {
            code: "STREAMING_ASSET_BUILD_FAILED",
            hints: {
                segmentedStartupHint: {
                    transient: "false",
                    retry_after_ms: "2500",
                },
            },
        },
    });

    const hint = parseSegmentedStartupErrorHint(error);
    assert.deepEqual(hint, {
        isTransient: false,
        retryAfterMs: 2500,
        code: "STREAMING_ASSET_BUILD_FAILED",
        statusCode: 502,
    });
});

test("parseSegmentedStartupErrorHint returns null when no startup hint exists", () => {
    const error = Object.assign(new Error("Track not found"), {
        status: 404,
        data: {
            code: "TRACK_NOT_FOUND",
            error: "Track not found",
        },
    });

    assert.equal(parseSegmentedStartupErrorHint(error), null);
});

test("parseSegmentedStartupErrorHint returns null for non-object input", () => {
    assert.equal(parseSegmentedStartupErrorHint("manifest timeout"), null);
    assert.equal(parseSegmentedStartupErrorHint(null), null);
});

test("parseSegmentedStartupErrorHint reads fallback fields from top-level error object", () => {
    const error = Object.assign(new Error("temporary outage"), {
        code: "SOCKET_TEMPORARY",
        status: 503.6,
        transient: "yes",
        retryAfterMs: "1500",
    });

    const hint = parseSegmentedStartupErrorHint(error);
    assert.deepEqual(hint, {
        isTransient: true,
        retryAfterMs: 1500,
        code: "SOCKET_TEMPORARY",
        statusCode: 504,
    });
});

test("parseSegmentedStartupErrorHint preserves partial hints", () => {
    const onlyRetryAfter = Object.assign(new Error("wait"), {
        data: {
            statusCode: 429.2,
            segmentedStartupRetryHint: {
                retryAfterMs: "1300",
            },
        },
    });
    const onlyTransient = Object.assign(new Error("do not retry"), {
        data: {
            code: "STREAMING_ASSET_DENIED",
            details: {
                hint: {
                    shouldRetry: "0",
                },
            },
        },
    });

    assert.deepEqual(parseSegmentedStartupErrorHint(onlyRetryAfter), {
        isTransient: null,
        retryAfterMs: 1300,
        code: null,
        statusCode: 429,
    });
    assert.deepEqual(parseSegmentedStartupErrorHint(onlyTransient), {
        isTransient: false,
        retryAfterMs: null,
        code: "STREAMING_ASSET_DENIED",
        statusCode: null,
    });
});

test("parseSegmentedStartupErrorHint ignores invalid hint values and continues scanning fallback records", () => {
    const error = Object.assign(new Error("still preparing"), {
        data: {
            segmentedStartupRetryHint: {
                transient: "maybe",
                retryAfterMs: 0,
            },
            details: {
                hint: {
                    retryAfterMs: "25",
                },
            },
        },
    });

    assert.deepEqual(parseSegmentedStartupErrorHint(error), {
        isTransient: null,
        retryAfterMs: 25,
        code: null,
        statusCode: null,
    });
});

test("resolveConservativeSegmentedStartupRetryDelayMs honors and bounds retry hints", () => {
    assert.equal(
        resolveConservativeSegmentedStartupRetryDelayMs({
            computedDelayMs: 900,
            retryAfterMsHint: 1800,
            maxDelayMs: 5000,
        }),
        1800,
    );
    assert.equal(
        resolveConservativeSegmentedStartupRetryDelayMs({
            computedDelayMs: 1400,
            retryAfterMsHint: 500,
            maxDelayMs: 5000,
        }),
        1400,
    );
    assert.equal(
        resolveConservativeSegmentedStartupRetryDelayMs({
            computedDelayMs: 900,
            retryAfterMsHint: 99999,
            maxDelayMs: 4000,
        }),
        4000,
    );
});

test("resolveConservativeSegmentedStartupRetryDelayMs handles invalid computed delay and hint caps", () => {
    assert.equal(
        resolveConservativeSegmentedStartupRetryDelayMs({
            computedDelayMs: Number.NaN,
            retryAfterMsHint: null,
            maxDelayMs: 5000,
        }),
        0,
    );
    assert.equal(
        resolveConservativeSegmentedStartupRetryDelayMs({
            computedDelayMs: 1200,
            retryAfterMsHint: 40_000,
            maxDelayMs: Number.NaN,
        }),
        30_000,
    );
});

test("resolveConservativeSegmentedStartupRetryDelayMs applies default max cap when maxDelayMs is omitted", () => {
    assert.equal(
        resolveConservativeSegmentedStartupRetryDelayMs({
            computedDelayMs: 800,
            retryAfterMsHint: 999_999,
        }),
        30_000,
    );
});
