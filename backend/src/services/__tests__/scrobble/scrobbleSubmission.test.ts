const post = jest.fn();
const findUnique = jest.fn();

jest.mock("axios", () => ({
    __esModule: true,
    default: { post, isAxiosError: jest.fn(() => false) },
}));
jest.mock("../../../utils/db", () => ({
    prisma: { scrobbleConnection: { findUnique } },
}));
jest.mock("../../../utils/encryption", () => ({
    decrypt: jest.fn(() => "stored-credential"),
}));
jest.mock("../../scrobbleConnections", () => ({
    resolveLastFmCredentials: jest.fn(async () => ({
        apiKey: "api-key",
        sharedSecret: "shared-secret",
    })),
}));

import { submitScrobbleJob } from "../../scrobbleSubmission";
import type { ScrobbleJobData } from "../../scrobbleTypes";

const baseJob: Omit<ScrobbleJobData, "service" | "kind"> = {
    userId: "user-1",
    listenedAtSeconds: 1_700_000_000,
    track: {
        artist: "Artist",
        title: "Track",
        album: "Album",
        durationSeconds: 240,
    },
};

describe("submitScrobbleJob", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        findUnique.mockResolvedValue({
            enabled: true,
            encryptedCredential: "encrypted-credential",
        });
        post.mockResolvedValue({ data: { status: "ok" } });
    });

    it.each([
        ["scrobble", "single", true],
        ["now_playing", "playing_now", false],
    ] as const)(
        "maps ListenBrainz %s submissions",
        async (kind, listenType, hasTimestamp) => {
            await submitScrobbleJob({
                ...baseJob,
                service: "listenbrainz",
                kind,
            });

            expect(post).toHaveBeenCalledWith(
                "https://api.listenbrainz.org/1/submit-listens",
                {
                    listen_type: listenType,
                    payload: [
                        expect.objectContaining({
                            ...(hasTimestamp
                                ? { listened_at: 1_700_000_000 }
                                : {}),
                            track_metadata: {
                                artist_name: "Artist",
                                track_name: "Track",
                                release_name: "Album",
                                additional_info: { duration_ms: 240_000 },
                            },
                        }),
                    ],
                },
                {
                    headers: { Authorization: "Token stored-credential" },
                    timeout: 8_000,
                },
            );
            const payload = post.mock.calls[0][1].payload[0];
            expect("listened_at" in payload).toBe(hasTimestamp);
        },
    );

    it.each([
        ["scrobble", "track.scrobble", true],
        ["now_playing", "track.updateNowPlaying", false],
    ] as const)(
        "maps Last.fm %s submissions to signed form calls",
        async (kind, method, hasTimestamp) => {
            post.mockResolvedValue({ data: {} });

            await submitScrobbleJob({
                ...baseJob,
                service: "lastfm",
                kind,
            });

            const [url, form, options] = post.mock.calls[0];
            expect(url).toBe("https://ws.audioscrobbler.com/2.0/");
            expect(form).toBeInstanceOf(URLSearchParams);
            expect(form.get("method")).toBe(method);
            expect(form.get("artist")).toBe("Artist");
            expect(form.get("track")).toBe("Track");
            expect(form.get("api_sig")).toMatch(/^[a-f0-9]{32}$/);
            expect(form.has("timestamp")).toBe(hasTimestamp);
            expect(options).toEqual({ timeout: 8_000 });
        },
    );
});
