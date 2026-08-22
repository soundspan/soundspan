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
