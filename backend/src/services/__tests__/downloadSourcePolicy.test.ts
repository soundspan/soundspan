const isLidarrEnabled = jest.fn();
const isSoulseekAvailable = jest.fn();
const isTidalAvailable = jest.fn();
const isYoutubeAvailable = jest.fn();

jest.mock("../lidarr", () => ({
    lidarrService: { isEnabled: isLidarrEnabled },
}));
jest.mock("../soulseek", () => ({
    soulseekService: { isAvailable: isSoulseekAvailable },
}));
jest.mock("../tidal", () => ({
    tidalService: { isAvailable: isTidalAvailable },
}));
jest.mock("../youtubeDownload", () => ({
    youtubeDownloadService: { isAvailable: isYoutubeAvailable },
}));

import {
    probeDownloadSourceAvailability,
    resolveDownloadSource,
} from "../downloadSourcePolicy";

const availability = {
    tidal: true,
    lidarr: true,
    soulseek: true,
    youtube: true,
};

describe("probeDownloadSourceAvailability", () => {
    it("fans out all source probes and returns the named availability snapshot", async () => {
        isLidarrEnabled.mockResolvedValueOnce(true);
        isSoulseekAvailable.mockResolvedValueOnce(false);
        isTidalAvailable.mockResolvedValueOnce(true);
        isYoutubeAvailable.mockResolvedValueOnce(false);

        await expect(probeDownloadSourceAvailability()).resolves.toEqual({
            tidal: true,
            lidarr: true,
            soulseek: false,
            youtube: false,
        });
        expect(isLidarrEnabled).toHaveBeenCalledTimes(1);
        expect(isSoulseekAvailable).toHaveBeenCalledTimes(1);
        expect(isTidalAvailable).toHaveBeenCalledTimes(1);
        expect(isYoutubeAvailable).toHaveBeenCalledTimes(1);
    });
});

describe("resolveDownloadSource", () => {
    it.each(["tidal", "lidarr", "soulseek", "youtube"] as const)(
        "dispatches an available configured %s source",
        (source) => {
            expect(
                resolveDownloadSource({
                    configuredSource: source,
                    fallback: "none",
                    availability,
                }),
            ).toEqual({ kind: "dispatch", source });
        },
    );

    it("dispatches youtube as an available explicit fallback", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "tidal",
                fallback: "youtube",
                availability: { ...availability, tidal: false },
            }),
        ).toEqual({ kind: "dispatch", source: "youtube" });
    });

    it("dispatches another source when youtube is unavailable", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "youtube",
                fallback: "soulseek",
                availability: { ...availability, youtube: false },
            }),
        ).toEqual({ kind: "dispatch", source: "soulseek" });
    });

    it("fails with the existing exact Skip status text", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "tidal",
                fallback: "none",
                availability: { ...availability, tidal: false },
            }),
        ).toEqual({
            kind: "fail",
            statusText: "tidal unavailable — skipped",
            error: 'tidal is unavailable and "When primary source fails" is set to Skip',
        });
    });

    it("fails for a self-referential fallback", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "youtube",
                fallback: "youtube",
                availability: { ...availability, youtube: false },
            }),
        ).toEqual({
            kind: "fail",
            statusText: "youtube unavailable — skipped",
            error: "youtube is unavailable and the configured fallback is also youtube",
        });
    });

    it("fails with the existing exact unavailable-fallback status text", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "tidal",
                fallback: "lidarr",
                availability: {
                    ...availability,
                    tidal: false,
                    lidarr: false,
                },
            }),
        ).toEqual({
            kind: "fail",
            statusText: "tidal and fallback lidarr unavailable",
            error: "tidal is unavailable and the configured fallback (lidarr) is also unavailable",
        });
    });

    it.each([
        ["tidal", "soulseek"],
        ["soulseek", "tidal"],
        ["lidarr", "tidal"],
        ["youtube", "tidal"],
    ] as const)(
        "uses the legacy ladder for unavailable %s when fallback is absent",
        (configuredSource, source) => {
            expect(
                resolveDownloadSource({
                    configuredSource,
                    fallback: undefined,
                    availability: {
                        ...availability,
                        [configuredSource]: false,
                    },
                }),
            ).toEqual({ kind: "dispatch", source });
        },
    );

    it("includes youtube at the end of an existing source's legacy ladder", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "tidal",
                fallback: undefined,
                availability: {
                    tidal: false,
                    soulseek: false,
                    lidarr: false,
                    youtube: true,
                },
            }),
        ).toEqual({ kind: "dispatch", source: "youtube" });
    });

    it("preserves the configured source when every legacy option is unavailable", () => {
        expect(
            resolveDownloadSource({
                configuredSource: "youtube",
                fallback: null,
                availability: {
                    tidal: false,
                    soulseek: false,
                    lidarr: false,
                    youtube: false,
                },
            }),
        ).toEqual({ kind: "dispatch", source: "youtube" });
    });
});
