import type { Prisma } from "@prisma/client";
import { Client } from "pg";

const mockSelectLibraryRadioStationTracks = jest.fn();

jest.mock("../src/services/libraryRadioStationSelection", () => ({
    isLibraryRadioPlaylistType: (value: string) =>
        ["genre", "decade", "discovery", "favorites", "workout"].includes(
            value,
        ),
    selectLibraryRadioStationTracks: mockSelectLibraryRadioStationTracks,
}));

import {
    appendRadioPlaylist,
    regenerateRadioPlaylist,
} from "../src/services/radioPlaylistService";
import { prisma } from "../src/utils/db";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;
const MAX_LOCK_OBSERVATIONS = 100;
const PLAYLIST_ID = "playlist-1";
const USER_ID = "user-1";
const ARTIST_ID = "artist-1";
const ALBUM_ID = "album-1";
const TRACK_COUNT = 100;
const REPLACEMENT_TRACK_COUNT = 10;
const FIXED_FILE_MODIFIED = new Date("2026-01-01T00:00:00.000Z");

function tracks(prefix: string, count: number, start = 1) {
    return Array.from({ length: count }, (_unused, index) => ({
        id: `${prefix}-${start + index}`,
    }));
}

async function seedUser(): Promise<void> {
    await prisma.user.create({
        data: { id: USER_ID, username: "radio-concurrency-user" },
    });
}

async function seedAlbum(): Promise<void> {
    await prisma.artist.create({
        data: {
            id: ARTIST_ID,
            mbid: "radio-concurrency-artist-mbid",
            name: "Radio Concurrency Artist",
        },
    });
    await prisma.album.create({
        data: {
            id: ALBUM_ID,
            rgMbid: "radio-concurrency-album-mbid",
            artistId: ARTIST_ID,
            title: "Radio Concurrency Album",
            primaryType: "Album",
        },
    });
}

async function seedTracks(): Promise<void> {
    const catalogTracks: Prisma.TrackCreateManyInput[] = [
        ...tracks("track", TRACK_COUNT),
        ...tracks("replacement-1", REPLACEMENT_TRACK_COUNT),
        ...tracks("replacement-2", REPLACEMENT_TRACK_COUNT),
    ].map((track, index) => ({
        id: track.id,
        albumId: ALBUM_ID,
        title: `Radio Concurrency Track ${index + 1}`,
        trackNo: index + 1,
        duration: 180,
        fileModified: FIXED_FILE_MODIFIED,
        fileSize: 1_000,
    }));
    const created = await prisma.track.createMany({ data: catalogTracks });
    expect(created.count).toBe(catalogTracks.length);
}

async function seedRequiredRows(): Promise<void> {
    await seedUser();
    await seedAlbum();
    await seedTracks();
}

async function seedPlaylist(itemCount: number): Promise<void> {
    await prisma.playlist.deleteMany({ where: { id: PLAYLIST_ID } });
    await prisma.playlist.create({
        data: {
            id: PLAYLIST_ID,
            userId: USER_ID,
            mixId: "radio-ephemeral:genre:rock",
            name: "Rock Radio",
        },
    });
    const created = await prisma.playlistItem.createMany({
        data: tracks("track", itemCount).map((track, index) => ({
            playlistId: PLAYLIST_ID,
            trackId: track.id,
            sort: index,
        })),
    });
    expect(created.count).toBe(itemCount);
}

async function waitForPlaylistLock(database: Client): Promise<void> {
    for (let attempt = 0; attempt < MAX_LOCK_OBSERVATIONS; attempt += 1) {
        const result = await database.query<{ waiting: boolean }>(`
            SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_stat_activity
                WHERE datname = current_database()
                  AND pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock'
            ) AS waiting
        `);
        if (result.rows[0]?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Concurrent regenerate did not wait for the playlist lock");
}

async function waitForFirstSelection(): Promise<void> {
    for (let attempt = 0; attempt < MAX_LOCK_OBSERVATIONS; attempt += 1) {
        if (mockSelectLibraryRadioStationTracks.mock.calls.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("First regenerate did not reach station selection");
}

describeWithPostgres("radio playlist PostgreSQL concurrency", () => {
    let admin: Client;
    let database: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        database = new Client({ connectionString: process.env.DATABASE_URL });
        await database.connect();
        await seedRequiredRows();
    });

    beforeEach(() => mockSelectLibraryRadioStationTracks.mockReset());

    afterAll(async () => {
        await prisma.$disconnect();
        await database?.end();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    it("keeps concurrent appends within the cap with unique sort positions", async () => {
        await seedPlaylist(90);
        mockSelectLibraryRadioStationTracks.mockImplementation(() => {
            const invocation =
                mockSelectLibraryRadioStationTracks.mock.calls.length;
            const additionStart = invocation === 1 ? 91 : 101;
            return {
                tracks: [
                    ...tracks("track", 90),
                    ...tracks("track", 10, additionStart),
                ],
            };
        });

        const results = await Promise.all([
            appendRadioPlaylist("user-1", "playlist-1", 20),
            appendRadioPlaylist("user-1", "playlist-1", 20),
        ]);
        const rows = await database.query<{
            item_count: number;
            sort_count: number;
            highest_sort: number;
        }>(`
            SELECT COUNT(*)::int AS item_count,
                   COUNT(DISTINCT sort)::int AS sort_count,
                   MAX(sort)::int AS highest_sort
            FROM "PlaylistItem" WHERE "playlistId" = 'playlist-1'
        `);

        expect(
            results.reduce((sum, result) => sum + result.entries.length, 0),
        ).toBe(10);
        expect(rows.rows[0]).toEqual({
            item_count: 100,
            sort_count: 100,
            highest_sort: 99,
        });
    });

    it("serializes concurrent regenerates into one complete replacement", async () => {
        await seedPlaylist(10);
        let releaseSelection!: () => void;
        const selectionGate = new Promise<void>((resolve) => {
            releaseSelection = resolve;
        });
        mockSelectLibraryRadioStationTracks.mockImplementation(async () => {
            const invocation =
                mockSelectLibraryRadioStationTracks.mock.calls.length;
            await selectionGate;
            return { tracks: tracks(`replacement-${invocation}`, 10) };
        });

        const first = regenerateRadioPlaylist("user-1", "playlist-1");
        await waitForFirstSelection();
        const second = regenerateRadioPlaylist("user-1", "playlist-1");
        let lockFailure: unknown;
        try {
            await waitForPlaylistLock(database);
        } catch (error) {
            lockFailure = error;
        } finally {
            releaseSelection();
        }
        await Promise.all([first, second]);
        if (lockFailure) throw lockFailure;

        const rows = await database.query<{ trackId: string; sort: number }>(`
            SELECT "trackId", sort FROM "PlaylistItem"
            WHERE "playlistId" = 'playlist-1' ORDER BY sort
        `);
        const trackIds = rows.rows.map((row) => row.trackId);
        expect(rows.rows).toHaveLength(10);
        expect(new Set(rows.rows.map((row) => row.sort)).size).toBe(10);
        expect(
            trackIds.every((id) => id.startsWith("replacement-1-")) ||
                trackIds.every((id) => id.startsWith("replacement-2-")),
        ).toBe(true);
    });
});
