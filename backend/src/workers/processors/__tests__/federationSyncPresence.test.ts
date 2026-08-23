const recordFederationPresenceFetch = jest.fn();
const storeFederationPeerPresenceSnapshot = jest.fn();
const mockLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLog.child.mockReturnValue(mockLog);

jest.mock("../../../config", () => ({
    config: { workers: { federationSyncIntervalMinutes: 15 } },
}));
jest.mock("../../../metrics", () => ({ recordFederationPresenceFetch }));
jest.mock("../../../services/federationPresence", () => ({
    storeFederationPeerPresenceSnapshot,
}));
jest.mock("../../../utils/logger", () => ({ logger: mockLog }));

import { refreshFederationPresence } from "../federationSyncPresence";

describe("federation sync presence", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("skips peers without the social scope", async () => {
        const getPresence = jest.fn();

        await expect(
            refreshFederationPresence(
                {
                    id: "peer-1",
                    name: "Remote",
                    scopes: ["library:read"],
                },
                { getPresence },
            ),
        ).resolves.toBeUndefined();

        expect(getPresence).not.toHaveBeenCalled();
        expect(storeFederationPeerPresenceSnapshot).not.toHaveBeenCalled();
        expect(recordFederationPresenceFetch).not.toHaveBeenCalled();
        expect(mockLog.debug).not.toHaveBeenCalled();
    });

    it("records and contains a legacy host 403", async () => {
        const forbidden = Object.assign(
            new Error("Federation peer returned 403"),
            { status: 403, transient: false },
        );
        const getPresence = jest.fn().mockRejectedValue(forbidden);

        await expect(
            refreshFederationPresence(
                {
                    id: "peer-1",
                    name: "Remote",
                    scopes: ["library:read", "social:read"],
                },
                { getPresence },
            ),
        ).resolves.toBeUndefined();

        expect(storeFederationPeerPresenceSnapshot).not.toHaveBeenCalled();
        expect(recordFederationPresenceFetch).toHaveBeenCalledWith(
            "peer-1",
            "failure",
        );
        expect(mockLog.debug).toHaveBeenCalledWith(
            "Federation peer presence fetch failed",
            { peerId: "peer-1", cause: forbidden },
        );
    });

    it("records failure and completes when the presence fetch never settles", async () => {
        const getPresence = jest.fn(() => new Promise<never>(() => undefined));
        const refresh = refreshFederationPresence(
            {
                id: "peer-1",
                name: "Remote",
                scopes: ["library:read", "social:read"],
            },
            { getPresence },
        );

        await jest.advanceTimersByTimeAsync(15_000);

        await expect(refresh).resolves.toBeUndefined();
        expect(storeFederationPeerPresenceSnapshot).not.toHaveBeenCalled();
        expect(recordFederationPresenceFetch).toHaveBeenCalledWith(
            "peer-1",
            "failure",
        );
    });
});
