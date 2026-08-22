const getSystemSettings = jest.fn();

jest.mock("../../utils/systemSettings", () => ({ getSystemSettings }));
jest.mock("../../config", () => ({
    config: { federation: { instanceName: "soundspan-host" } },
}));

import { resolveFederationInstanceName } from "../federationInstanceName";

describe("federation instance name", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("prefers the configured system setting", async () => {
        getSystemSettings.mockResolvedValue({
            federationInstanceName: "Living Room Library",
        });

        await expect(resolveFederationInstanceName()).resolves.toBe(
            "Living Room Library",
        );
    });

    it.each([null, undefined, "", "   "])(
        "falls back to config for %p",
        async (federationInstanceName) => {
            getSystemSettings.mockResolvedValue({ federationInstanceName });

            await expect(resolveFederationInstanceName()).resolves.toBe(
                "soundspan-host",
            );
        },
    );
});
