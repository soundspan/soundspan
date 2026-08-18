import assert from "node:assert/strict";
import test from "node:test";

import { getUnsupportedNodeMessage } from "../../scripts/check-node-version.mjs";

test("accepts Node 24 and newer", () => {
    assert.equal(getUnsupportedNodeMessage("24.0.0"), null);
    assert.equal(getUnsupportedNodeMessage("26.1.0"), null);
});

test("rejects an older Node version with upgrade guidance", () => {
    assert.equal(
        getUnsupportedNodeMessage("22.23.2"),
        "Component tests require Node.js 24 or newer per the root .nvmrc. Current version: v22.23.2. Run `nvm use` or select Node 24 with your version manager.",
    );
});
