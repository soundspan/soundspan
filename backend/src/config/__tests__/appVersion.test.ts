import fs from "node:fs";
import { resolveAppVersion } from "../appVersion";

describe("app version", () => {
    afterEach(() => jest.restoreAllMocks());

    it("reads the backend package version", () => {
        expect(resolveAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it.each(["{}", '{"version":0}', '{"version":""}'])(
        "rejects a manifest without a usable version: %s",
        (manifest) => {
            jest.spyOn(fs, "readFileSync").mockReturnValue(manifest);
            expect(() => resolveAppVersion()).toThrow(
                "missing a string version",
            );
        },
    );
});
