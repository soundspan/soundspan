import { jest } from "@jest/globals";
import type { PrismaClient } from "@prisma/client";
import { runUmapMaterialization } from "../umapMaterialization";
import type { UmapWorkerMessage } from "../umapWorkerProtocol";

describe("UMAP worker orchestration", () => {
    it("publishes undersized rows without fitting and disconnects", async () => {
        const rows = [
            {
                track_id: "track-1",
                title: "Track 1",
                artistName: "Artist",
                artistId: "artist-1",
                albumId: "album-1",
                coverUrl: null,
                loudnessLufs: null,
                truePeakDb: null,
                albumLoudnessLufs: null,
                albumTruePeakDb: null,
                energy: 0.5,
                valence: 0.5,
                moodHappy: null,
                moodSad: null,
                moodRelaxed: null,
                moodAggressive: null,
                moodParty: null,
                moodAcoustic: null,
                moodElectronic: null,
                embedding: "[1,2,3]",
            },
        ];
        const database = {
            $queryRaw: jest.fn(async () => rows),
            $disconnect: jest.fn(async () => undefined),
        } as unknown as PrismaClient;
        const publish = jest.fn<(message: UmapWorkerMessage) => void>();

        await runUmapMaterialization(
            { spaceId: "space-1", sampleSize: 10 },
            publish,
            () => database,
        );

        expect(publish).toHaveBeenNthCalledWith(1, {
            type: "materialized",
            rowCount: 1,
        });
        const { embedding: _embedding, ...expectedRow } = rows[0];
        expect(publish).toHaveBeenNthCalledWith(2, {
            type: "result",
            rows: [expectedRow],
            projection: null,
        });
        expect(database.$disconnect).toHaveBeenCalledTimes(1);
    });

    it("disconnects when materialization fails", async () => {
        const failure = new Error("query failed");
        const database = {
            $queryRaw: jest.fn(async () => {
                throw failure;
            }),
            $disconnect: jest.fn(async () => undefined),
        } as unknown as PrismaClient;

        await expect(
            runUmapMaterialization(
                { spaceId: "space-1", sampleSize: 10 },
                jest.fn(),
                () => database,
            ),
        ).rejects.toBe(failure);
        expect(database.$disconnect).toHaveBeenCalledTimes(1);
    });
});
