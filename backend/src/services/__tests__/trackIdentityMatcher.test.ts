import {
    matchTrackIdentities,
    type TrackIdentity,
} from "../trackIdentityMatcher";

function track(
    id: string,
    overrides: Partial<TrackIdentity> = {},
): TrackIdentity {
    return {
        id,
        filePath: `${id}.flac`,
        fileSize: 1_000,
        duration: 180,
        title: `Title ${id}`,
        discNo: 1,
        trackNo: 1,
        audioHash: null,
        recordingMbid: null,
        isrc: null,
        album: { rgMbid: null },
        ...overrides,
    };
}

describe("matchTrackIdentities", () => {
    it("uses audio hash before conflicting lower-tier identity keys", () => {
        const missing = track("missing", {
            audioHash: "sha256:audio",
            recordingMbid: "recording-a",
        });
        const hashCandidate = track("hash-candidate", {
            audioHash: "sha256:audio",
            recordingMbid: "recording-b",
        });
        const tagCandidate = track("tag-candidate", {
            audioHash: "sha256:different",
            recordingMbid: "recording-a",
        });

        const matches = matchTrackIdentities(
            [missing],
            [tagCandidate, hashCandidate],
        );

        expect(matches).toEqual([
            { missing, candidate: hashCandidate, tier: "audioHash" },
        ]);
    });

    it("matches each lower tier in strict precedence order", () => {
        const missingRecording = track("missing-recording", {
            recordingMbid: "recording-1",
        });
        const candidateRecording = track("candidate-recording", {
            recordingMbid: "recording-1",
        });
        const missingIsrc = track("missing-isrc", { isrc: "USRC10000001" });
        const candidateIsrc = track("candidate-isrc", {
            isrc: "USRC10000001",
        });
        const missingAlbum = track("missing-album", {
            album: { rgMbid: "release-group-1" },
            discNo: 2,
            trackNo: 4,
            title: "Café  Song",
            duration: 200,
        });
        const candidateAlbum = track("candidate-album", {
            album: { rgMbid: "release-group-1" },
            discNo: 2,
            trackNo: 4,
            title: " cafe song ",
            duration: 210,
        });
        const missingFile = track("missing-file", {
            fileSize: 9_999,
            title: "Final Song",
            duration: 300,
        });
        const candidateFile = track("candidate-file", {
            fileSize: 9_999,
            title: " final song ",
            duration: 302,
        });

        const matches = matchTrackIdentities(
            [missingRecording, missingIsrc, missingAlbum, missingFile],
            [candidateFile, candidateAlbum, candidateIsrc, candidateRecording],
        );

        expect(matches).toEqual(
            expect.arrayContaining([
                {
                    missing: missingRecording,
                    candidate: candidateRecording,
                    tier: "recordingMbid",
                },
                {
                    missing: missingIsrc,
                    candidate: candidateIsrc,
                    tier: "isrc",
                },
                {
                    missing: missingAlbum,
                    candidate: candidateAlbum,
                    tier: "albumPositionTitleDuration",
                },
                {
                    missing: missingFile,
                    candidate: candidateFile,
                    tier: "fileSizeTitleDuration",
                },
            ]),
        );
        expect(matches).toHaveLength(4);
    });

    it("lets a lower tier disambiguate identical audio hashes", () => {
        const missingOne = track("missing-1", {
            audioHash: "sha256:duplicate",
            recordingMbid: "recording-1",
        });
        const missingTwo = track("missing-2", {
            audioHash: "sha256:duplicate",
            recordingMbid: "recording-2",
        });
        const candidateOne = track("candidate-1", {
            audioHash: "sha256:duplicate",
            recordingMbid: "recording-1",
        });
        const candidateTwo = track("candidate-2", {
            audioHash: "sha256:duplicate",
            recordingMbid: "recording-2",
        });

        const matches = matchTrackIdentities(
            [missingOne, missingTwo],
            [candidateTwo, candidateOne],
        );

        expect(matches).toEqual(
            expect.arrayContaining([
                {
                    missing: missingOne,
                    candidate: candidateOne,
                    tier: "recordingMbid",
                },
                {
                    missing: missingTwo,
                    candidate: candidateTwo,
                    tier: "recordingMbid",
                },
            ]),
        );
    });

    it("abstains when identical rows remain ambiguous through every tier", () => {
        const shared = {
            audioHash: "sha256:duplicate",
            recordingMbid: "recording-shared",
            isrc: "USRC10000001",
            album: { rgMbid: "release-group-shared" },
            discNo: 1,
            trackNo: 1,
            title: "Duplicate",
            duration: 180,
            fileSize: 5_000,
        };

        const matches = matchTrackIdentities(
            [track("missing-1", shared), track("missing-2", shared)],
            [track("candidate-1", shared), track("candidate-2", shared)],
        );

        expect(matches).toEqual([]);
    });

    it("abstains when one candidate is claimed by multiple missing rows", () => {
        const shared = { recordingMbid: "recording-shared" };

        const matches = matchTrackIdentities(
            [track("missing-1", shared), track("missing-2", shared)],
            [track("candidate", shared)],
        );

        expect(matches).toEqual([]);
    });

    it("rejects duration and title matches outside their boundaries", () => {
        const missingAlbum = track("missing-album", {
            album: { rgMbid: "release-group" },
            title: "Album Song",
            duration: 100,
        });
        const candidateAlbum = track("candidate-album", {
            album: { rgMbid: "release-group" },
            title: "Album Song",
            duration: 111,
        });
        const missingFile = track("missing-file", {
            fileSize: 4_000,
            title: "File Song",
            duration: 200,
        });
        const candidateFile = track("candidate-file", {
            fileSize: 4_000,
            title: "Different Song",
            duration: 201,
        });

        expect(
            matchTrackIdentities(
                [missingAlbum, missingFile],
                [candidateAlbum, candidateFile],
            ),
        ).toEqual([]);
    });
});
