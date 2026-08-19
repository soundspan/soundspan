import { jest } from "@jest/globals";
import { Client } from "pg";
import { createPrismaClient } from "../src/utils/prismaClientFactory";
import { runUmapMaterialization } from "../src/workers/umapMaterialization";
import type { UmapWorkerMessage } from "../src/workers/umapWorkerProtocol";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;
const SPACE_ID = "space-umap-integration";

function baseDatabaseUrl(databaseUrl: string): string {
    const parsed = new URL(databaseUrl);
    parsed.searchParams.delete("schema");
    return parsed.toString();
}

async function createSchema(database: Client): Promise<void> {
    await database.query(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE TYPE "TrackOrigin" AS ENUM ('LOCAL', 'FEDERATED');
        CREATE TABLE "Artist" (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE "Album" (
            id TEXT PRIMARY KEY,
            "artistId" TEXT NOT NULL REFERENCES "Artist"(id),
            "coverUrl" TEXT,
            "albumLoudnessLufs" DOUBLE PRECISION,
            "albumTruePeakDb" DOUBLE PRECISION
        );
        CREATE TABLE "FederationPeer" (
            id TEXT PRIMARY KEY,
            "showDedupedCopies" BOOLEAN NOT NULL DEFAULT false
        );
        CREATE TABLE "Track" (
            id TEXT PRIMARY KEY,
            "albumId" TEXT NOT NULL REFERENCES "Album"(id),
            title TEXT NOT NULL,
            origin "TrackOrigin" NOT NULL DEFAULT 'LOCAL',
            "peerId" TEXT,
            "dedupOfTrackId" TEXT,
            "removedAt" TIMESTAMP(3),
            "loudnessLufs" DOUBLE PRECISION,
            "truePeakDb" DOUBLE PRECISION,
            energy DOUBLE PRECISION,
            valence DOUBLE PRECISION,
            "moodHappy" DOUBLE PRECISION,
            "moodSad" DOUBLE PRECISION,
            "moodRelaxed" DOUBLE PRECISION,
            "moodAggressive" DOUBLE PRECISION,
            "moodParty" DOUBLE PRECISION,
            "moodAcoustic" DOUBLE PRECISION,
            "moodElectronic" DOUBLE PRECISION
        );
        CREATE TABLE track_embeddings (
            track_id TEXT NOT NULL REFERENCES "Track"(id),
            space_id TEXT NOT NULL,
            embedding vector(3) NOT NULL,
            PRIMARY KEY (track_id, space_id)
        );
    `);
}

async function seedRows(database: Client): Promise<void> {
    // Parameterized queries use the extended protocol, which allows exactly
    // one command per statement — seed each table separately.
    await database.query(
        `INSERT INTO "Artist" (id, name) VALUES ('artist-1', 'Artist 1')`,
    );
    await database.query(
        `INSERT INTO "Album" (id, "artistId") VALUES ('album-1', 'artist-1')`,
    );
    await database.query(`
        INSERT INTO "Track" (id, "albumId", title, energy, valence)
        SELECT 'track-' || value, 'album-1', 'Track ' || value,
               value::double precision / 10,
               1 - value::double precision / 10
        FROM generate_series(1, 6) AS value
    `);
    await database.query(
        `
        INSERT INTO track_embeddings (track_id, space_id, embedding)
        SELECT 'track-' || value, $1,
               ('[' || value || ',' || (value + 1) || ',' || (value + 2) || ']')::vector
        FROM generate_series(1, 6) AS value
    `,
        [SPACE_ID],
    );
}

describeWithPostgres("UMAP materialization PostgreSQL correctness", () => {
    let admin: Client;
    let database: Client;
    let adminConnected = false;
    let databaseCreated = false;

    beforeAll(async () => {
        if (!/^vibe_x2_\d+_\d+$/.test(databaseName!)) {
            throw new Error("Integration database name is unsafe");
        }
        admin = new Client({
            connectionString: baseDatabaseUrl(integrationDatabaseUrl!),
        });
        await admin.connect();
        adminConnected = true;
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;
        database = new Client({ connectionString: process.env.DATABASE_URL });
        await database.connect();
        await createSchema(database);
        await seedRows(database);
    });

    afterAll(async () => {
        await database?.end();
        if (adminConnected) {
            if (databaseCreated && databaseName) {
                await admin.query(
                    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
                );
            }
            await admin.end();
        }
    });

    it("queries and parses pgvector rows into two-dimensional coordinates", async () => {
        const messages: UmapWorkerMessage[] = [];

        await runUmapMaterialization(
            { spaceId: SPACE_ID, sampleSize: 6 },
            (message) => messages.push(message),
        );

        expect(messages[0]).toEqual({ type: "materialized", rowCount: 6 });
        const result = messages[1];
        expect(result?.type).toBe("result");
        if (result?.type !== "result") throw new Error("missing UMAP result");
        expect(result.rows).toHaveLength(6);
        expect(result.rows.map((row) => row.track_id).sort()).toEqual([
            "track-1",
            "track-2",
            "track-3",
            "track-4",
            "track-5",
            "track-6",
        ]);
        expect(result.projection).toHaveLength(6);
        for (const coordinate of result.projection ?? []) {
            expect(coordinate).toHaveLength(2);
            expect(coordinate.every(Number.isFinite)).toBe(true);
        }
    });

    it("disconnects its Prisma client when the real query fails", async () => {
        await database.query(
            "ALTER TABLE track_embeddings RENAME TO unavailable_embeddings",
        );
        const client = createPrismaClient({
            connectionLimit: 1,
            poolTimeoutSeconds: 30,
        });
        const disconnect = jest.spyOn(client, "$disconnect");

        try {
            await expect(
                runUmapMaterialization(
                    { spaceId: SPACE_ID, sampleSize: 6 },
                    jest.fn(),
                    () => client,
                ),
            ).rejects.toThrow();
            expect(disconnect).toHaveBeenCalledTimes(1);
        } finally {
            await database.query(
                "ALTER TABLE unavailable_embeddings RENAME TO track_embeddings",
            );
        }
    });
});
