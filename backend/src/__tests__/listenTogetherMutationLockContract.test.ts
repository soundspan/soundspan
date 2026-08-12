import fs from "fs";
import path from "path";

describe("listen together mutation lock contract", () => {
    const socketServicePath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherSocket.ts",
    );

    const socketSource = fs.readFileSync(socketServicePath, "utf8");

    it("wraps hot-path mutations with per-group lock", () => {
        expect(socketSource).toContain("withGroupMutationLock(");
        expect(socketSource).toContain("`playback:${data.action}`");
        expect(socketSource).toContain('"queue:add"');
        expect(socketSource).toContain('"ready"');
    });
});
