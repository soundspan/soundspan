import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
    BASELINE,
    countArbitraryHexClasses,
    scanRepo,
} from "../../scripts/check-hardcoded-hex.mjs";

test("counts arbitrary-value hex color utilities", () => {
    assert.equal(
        countArbitraryHexClasses("a bg-[#3b82f6] text-[#fff] w-4"),
        2
    );
});

test("ignores token and palette color utilities", () => {
    assert.equal(countArbitraryHexClasses("bg-brand text-gray-400"), 0);
});

test("frontend arbitrary-value hex utilities stay within the baseline", () => {
    const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

    assert.ok(scanRepo(frontendRoot) <= BASELINE);
});
