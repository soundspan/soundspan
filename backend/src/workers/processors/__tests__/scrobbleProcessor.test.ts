const submit = jest.fn();
const record = jest.fn();
const updateMany = jest.fn();
const findMany = jest.fn();
const add = jest.fn();

jest.mock("../../../services/scrobbleSubmission", () => ({
    submitScrobbleJob: submit,
    InvalidScrobbleAuthError: class InvalidScrobbleAuthError extends Error {
        constructor(public readonly encryptedCredential?: string) {
            super();
        }
    },
}));
jest.mock("../../../metrics", () => ({ recordScrobbleOutcome: record }));
jest.mock("../../../utils/db", () => ({
    prisma: { scrobbleConnection: { updateMany, findMany } },
}));
jest.mock("../../../workers/queues", () => ({
    scrobbleQueue: { add },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

import { processScrobble } from "../scrobbleProcessor";
import { InvalidScrobbleAuthError } from "../../../services/scrobbleSubmission";
import { forwardScrobble } from "../../../services/scrobbleForwarder";

const job = (attemptsMade: number, attempts = 3) =>
    ({
        data: {
            service: "lastfm",
            userId: "user-1",
            kind: "scrobble",
            listenedAtSeconds: 1_700_000_000,
            track: { artist: "Artist", title: "Track" },
        },
        attemptsMade,
        opts: { attempts },
    }) as never;

describe("processScrobble", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        updateMany.mockResolvedValue({ count: 1 });
        add.mockResolvedValue({ id: "job-1" });
    });

    it("records a retry and rethrows before attempts are exhausted", async () => {
        submit.mockRejectedValue(new Error("temporary"));

        await expect(processScrobble(job(0))).rejects.toThrow("temporary");
        expect(record).toHaveBeenCalledWith("lastfm", "retried");
    });

    it("drops a transient failure after the final attempt", async () => {
        submit.mockRejectedValue(new Error("still unavailable"));

        await expect(processScrobble(job(2))).resolves.toEqual("dropped");
        expect(record).toHaveBeenCalledWith("lastfm", "dropped");
    });

    it("disables invalid authentication and excludes it from later forwarding", async () => {
        let enabled = true;
        updateMany.mockImplementation(async () => {
            enabled = false;
            return { count: 1 };
        });
        findMany.mockImplementation(async () =>
            enabled ? [{ service: "lastfm" }] : [],
        );
        submit.mockRejectedValue(new InvalidScrobbleAuthError("cipher-old"));

        await expect(processScrobble(job(0))).resolves.toEqual("invalid_auth");
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                service: "lastfm",
                enabled: true,
                encryptedCredential: "cipher-old",
            },
            data: { enabled: false },
        });
        expect(record).toHaveBeenCalledWith("lastfm", "invalid_auth");

        await forwardScrobble({
            userId: "user-1",
            mediaType: "music",
            kind: "scrobble",
            listenedAt: new Date(1_700_000_000_000),
            track: { artist: "Artist", title: "Track" },
        });

        expect(add).not.toHaveBeenCalled();
    });

    it("never disables a reauthenticated credential from a stale in-flight job", async () => {
        // The failed submission used the OLD credential; the disable must
        // compare-and-swap on that exact ciphertext, so a row holding a new
        // credential is left untouched (updateMany matches zero rows).
        updateMany.mockResolvedValue({ count: 0 });
        submit.mockRejectedValue(new InvalidScrobbleAuthError("cipher-old"));

        await expect(processScrobble(job(0))).resolves.toEqual("invalid_auth");
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                service: "lastfm",
                enabled: true,
                encryptedCredential: "cipher-old",
            },
            data: { enabled: false },
        });
    });

    it("skips the disable entirely when no credential was in play", async () => {
        submit.mockRejectedValue(new InvalidScrobbleAuthError());

        await expect(processScrobble(job(0))).resolves.toEqual("invalid_auth");
        expect(updateMany).not.toHaveBeenCalled();
    });
});
