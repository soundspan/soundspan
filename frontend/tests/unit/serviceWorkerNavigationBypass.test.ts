import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceWorkerSource = readFileSync(
    new URL("../../public/sw.js", import.meta.url),
    "utf8"
);

test("service worker bypasses Next.js route transition requests", () => {
    assert.match(serviceWorkerSource, /request\.mode === 'navigate'/);
    assert.match(serviceWorkerSource, /request\.headers\.get\('RSC'\) === '1'/);
    assert.match(serviceWorkerSource, /request\.headers\.has\('Next-Router-State-Tree'\)/);
    assert.match(serviceWorkerSource, /url\.pathname\.startsWith\('\/_next\/'\)/);
});

test("service worker keeps conservative cover-art concurrency", () => {
    assert.match(
        serviceWorkerSource,
        /const MAX_CONCURRENT_IMAGE_REQUESTS = 4;/
    );
});
