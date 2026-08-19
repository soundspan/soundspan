import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
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
import playlistRouter from "../src/routes/playlists";
import { handleUpdatePlaylist } from "../src/routes/subsonic/playlists";
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
const ADD_INSERT_GATE_KEY = 71_905;
const FIXED_FILE_MODIFIED = new Date("2026-01-01T00:00:00.000Z");

type RouteResponse = {
    statusCode: number;
    body: unknown;
    status(code: number): RouteResponse;
    json(body: unknown): RouteResponse;
};

type SubsonicRouteResponse = {
    response: Response;
    readonly statusCode: number;
    readonly body: unknown;
};

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

async function waitForWaitingConnections(
    database: Client,
    minimum: number,
    failureMessage: string,
): Promise<void> {
    for (let attempt = 0; attempt < MAX_LOCK_OBSERVATIONS; attempt += 1) {
        const result = await database.query<{ waiting: number }>(`
            SELECT COUNT(*)::int AS waiting
            FROM pg_catalog.pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
        `);
        if ((result.rows[0]?.waiting ?? 0) >= minimum) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(failureMessage);
}

async function waitForPlaylistLock(database: Client): Promise<void> {
    return waitForWaitingConnections(
        database,
        1,
        "Concurrent regenerate did not wait for the playlist lock",
    );
}

function createRouteResponse(): RouteResponse {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function createSubsonicRouteResponse(): SubsonicRouteResponse {
    let statusCode = 200;
    let body: unknown;
    const response = {
        locals: {},
        status(code: number) {
            statusCode = code;
            return this;
        },
        set() {
            return this;
        },
        type() {
            return this;
        },
        send(value: unknown) {
            body = typeof value === "string" ? JSON.parse(value) : value;
            return this;
        },
    } as unknown as Response;
    return {
        response,
        get statusCode() {
            return statusCode;
        },
        get body() {
            return body;
        },
    };
}

function getOrdinaryAddHandler() {
    type RouterLayer = {
        route?: {
            path?: string;
            methods?: Record<string, boolean>;
            stack?: Array<{ handle: (...args: never[]) => unknown }>;
        };
    };
    const layers = (playlistRouter as unknown as { stack: RouterLayer[] })
        .stack;
    const route = layers.find(
        (layer) =>
            layer.route?.path === "/:id/items" && layer.route.methods?.post,
    )?.route;
    const handler = route?.stack?.at(-1)?.handle;
    if (!handler) throw new Error("Ordinary playlist add handler not found");
    return handler;
}

function getOrdinaryRemoveHandler() {
    type RouterLayer = {
        route?: {
            path?: string;
            methods?: Record<string, boolean>;
            stack?: Array<{ handle: (...args: never[]) => unknown }>;
        };
    };
    const layers = (playlistRouter as unknown as { stack: RouterLayer[] })
        .stack;
    const route = layers.find(
        (layer) =>
            layer.route?.path === "/:id/items/:trackId" &&
            layer.route.methods?.delete,
    )?.route;
    const handler = route?.stack?.at(-1)?.handle;
    if (!handler) throw new Error("Ordinary playlist remove handler not found");
    return handler;
}

async function addPlaylistItemThroughRoute(
    trackId: string,
    response: RouteResponse,
): Promise<void> {
    const handler = getOrdinaryAddHandler();
    await handler(
        {
            user: { id: USER_ID },
            params: { id: PLAYLIST_ID },
            body: { trackId },
        } as never,
        response as never,
        (() => undefined) as never,
    );
}

async function removePlaylistItemThroughRoute(
    itemId: string,
    response: RouteResponse,
): Promise<void> {
    const handler = getOrdinaryRemoveHandler();
    await handler(
        {
            user: { id: USER_ID },
            params: { id: PLAYLIST_ID, trackId: itemId },
        } as never,
        response as never,
        (() => undefined) as never,
    );
}

async function updatePlaylistThroughSubsonic(
    response: Response,
): Promise<void> {
    await handleUpdatePlaylist(
        {
            query: {
                f: "json",
                playlistId: `pl-${PLAYLIST_ID}`,
                songIndexToRemove: "0",
                songIdToAdd: "tr-track-11",
            },
            user: {
                id: USER_ID,
                username: "radio-concurrency-user",
                role: "USER",
            },
        } as unknown as Request,
        response,
    );
}

async function installAddInsertGate(database: Client): Promise<void> {
    await database.query(`
        CREATE FUNCTION hold_playlist_item_insert() RETURNS trigger AS $$
        BEGIN
            IF NEW."playlistId" = '${PLAYLIST_ID}' THEN
                PERFORM set_config('deadlock_timeout', '50ms', true);
                PERFORM pg_advisory_xact_lock(${ADD_INSERT_GATE_KEY});
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER hold_playlist_item_insert
        AFTER INSERT ON "PlaylistItem"
        FOR EACH ROW EXECUTE FUNCTION hold_playlist_item_insert()
    `);
}

async function removeAddInsertGate(database: Client): Promise<void> {
    await database.query(`
        DROP TRIGGER IF EXISTS hold_playlist_item_insert ON "PlaylistItem";
        DROP FUNCTION IF EXISTS hold_playlist_item_insert()
    `);
}

async function runThreeWayMutations(blocker: Client, database: Client) {
    const firstResponse = createRouteResponse();
    const secondResponse = createRouteResponse();
    let gateOpen = false;
    const pendingOperations: Promise<unknown>[] = [];

    try {
        await blocker.query("SELECT pg_advisory_lock($1)", [
            ADD_INSERT_GATE_KEY,
        ]);
        gateOpen = true;
        const firstAdd = addPlaylistItemThroughRoute("track-11", firstResponse);
        pendingOperations.push(firstAdd);
        await waitForWaitingConnections(
            database,
            1,
            "First ordinary add did not reach the insert gate",
        );

        const secondAdd = addPlaylistItemThroughRoute(
            "track-12",
            secondResponse,
        );
        const regenerate = regenerateRadioPlaylist(USER_ID, PLAYLIST_ID);
        pendingOperations.push(secondAdd, regenerate);
        await waitForWaitingConnections(
            database,
            3,
            "Three-way playlist mutations did not reach their lock waits",
        );
        await blocker.query("SELECT pg_advisory_unlock($1)", [
            ADD_INSERT_GATE_KEY,
        ]);
        gateOpen = false;
        const results = await Promise.allSettled([
            firstAdd,
            secondAdd,
            regenerate,
        ]);
        return { results, firstResponse, secondResponse };
    } finally {
        if (gateOpen) {
            await blocker.query("SELECT pg_advisory_unlock($1)", [
                ADD_INSERT_GATE_KEY,
            ]);
        }
        await Promise.allSettled(pendingOperations);
    }
}

async function expectConsistentThreeWayState(database: Client): Promise<void> {
    const rows = await database.query<{ trackId: string; sort: number }>(`
        SELECT "trackId", sort FROM "PlaylistItem"
        WHERE "playlistId" = '${PLAYLIST_ID}' ORDER BY sort
    `);
    const trackIds = rows.rows.map((row) => row.trackId);
    const replacementIds = tracks("replacement-1", REPLACEMENT_TRACK_COUNT).map(
        (track) => track.id,
    );

    expect(rows.rows.length).toBeGreaterThanOrEqual(REPLACEMENT_TRACK_COUNT);
    expect(rows.rows.length).toBeLessThanOrEqual(TRACK_COUNT);
    expect(rows.rows.map((row) => row.sort)).toEqual(
        Array.from({ length: rows.rows.length }, (_unused, index) => index),
    );
    expect(new Set(trackIds).size).toBe(rows.rows.length);
    expect(replacementIds.every((id) => trackIds.includes(id))).toBe(true);
    expect(
        trackIds.every(
            (id) =>
                replacementIds.includes(id) ||
                id === "track-11" ||
                id === "track-12",
        ),
    ).toBe(true);
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
    let blocker: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        database = new Client({ connectionString: process.env.DATABASE_URL });
        await database.connect();
        blocker = new Client({ connectionString: process.env.DATABASE_URL });
        await blocker.connect();
        await seedRequiredRows();
    });

    beforeEach(() => mockSelectLibraryRadioStationTracks.mockReset());

    afterAll(async () => {
        await prisma.$disconnect();
        await blocker?.end();
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

    it("serializes radio regeneration behind an ordinary edit without deadlock or 500", async () => {
        await seedPlaylist(10);
        const target = await prisma.playlistItem.findFirstOrThrow({
            where: { playlistId: PLAYLIST_ID },
            select: { id: true },
            orderBy: { sort: "asc" },
        });
        mockSelectLibraryRadioStationTracks.mockResolvedValue({
            tracks: tracks("replacement-1", 10),
        });
        const response = createRouteResponse();
        let blockerOpen = false;
        const pendingOperations: Promise<unknown>[] = [];

        try {
            await blocker.query("BEGIN");
            blockerOpen = true;
            await blocker.query(
                'SELECT id FROM "PlaylistItem" WHERE id = $1 FOR UPDATE',
                [target.id],
            );

            const ordinaryEdit = removePlaylistItemThroughRoute(
                target.id,
                response,
            );
            pendingOperations.push(ordinaryEdit);
            await waitForWaitingConnections(
                database,
                1,
                "Ordinary playlist edit did not wait for the item lock",
            );

            const regenerate = regenerateRadioPlaylist(USER_ID, PLAYLIST_ID);
            pendingOperations.push(regenerate);
            await waitForWaitingConnections(
                database,
                2,
                "Radio regeneration did not wait behind the ordinary edit",
            );
            expect(mockSelectLibraryRadioStationTracks).not.toHaveBeenCalled();

            await blocker.query("COMMIT");
            blockerOpen = false;
            const results = await Promise.allSettled([
                ordinaryEdit,
                regenerate,
            ]);

            expect(results.map((result) => result.status)).toEqual([
                "fulfilled",
                "fulfilled",
            ]);
            expect(response.statusCode).toBe(200);
            expect(response.body).toEqual({
                message: "Track removed from playlist",
            });
        } finally {
            if (blockerOpen) await blocker.query("ROLLBACK");
            await Promise.allSettled(pendingOperations);
        }
    });

    it("serializes Subsonic mutation with regeneration without deadlock or mixed state", async () => {
        await seedPlaylist(10);
        const target = await prisma.playlistItem.findFirstOrThrow({
            where: { playlistId: PLAYLIST_ID },
            select: { id: true },
            orderBy: { sort: "asc" },
        });
        mockSelectLibraryRadioStationTracks.mockResolvedValue({
            tracks: tracks("replacement-1", REPLACEMENT_TRACK_COUNT),
        });
        const response = createSubsonicRouteResponse();
        let blockerOpen = false;
        const pendingOperations: Promise<unknown>[] = [];

        try {
            await blocker.query("BEGIN");
            blockerOpen = true;
            await blocker.query(
                'SELECT id FROM "PlaylistItem" WHERE id = $1 FOR UPDATE',
                [target.id],
            );

            const subsonicMutation = updatePlaylistThroughSubsonic(
                response.response,
            );
            pendingOperations.push(subsonicMutation);
            await waitForWaitingConnections(
                database,
                1,
                "Subsonic playlist mutation did not wait for the item lock",
            );

            const regenerate = regenerateRadioPlaylist(USER_ID, PLAYLIST_ID);
            pendingOperations.push(regenerate);
            await waitForWaitingConnections(
                database,
                2,
                "Radio regeneration did not wait behind the Subsonic mutation",
            );
            expect(mockSelectLibraryRadioStationTracks).not.toHaveBeenCalled();

            await blocker.query("COMMIT");
            blockerOpen = false;
            const results = await Promise.allSettled([
                subsonicMutation,
                regenerate,
            ]);

            expect(results.map((result) => result.status)).toEqual([
                "fulfilled",
                "fulfilled",
            ]);
            expect(response.statusCode).toBe(200);
            expect(response.body).toMatchObject({
                "subsonic-response": { status: "ok" },
            });
            const rows = await database.query<{
                trackId: string;
                sort: number;
            }>(`
                SELECT "trackId", sort FROM "PlaylistItem"
                WHERE "playlistId" = '${PLAYLIST_ID}' ORDER BY sort
            `);
            expect(rows.rows).toEqual(
                tracks("replacement-1", REPLACEMENT_TRACK_COUNT).map(
                    (track, index) => ({ trackId: track.id, sort: index }),
                ),
            );
        } finally {
            if (blockerOpen) await blocker.query("ROLLBACK");
            await Promise.allSettled(pendingOperations);
        }
    });

    it("serializes two ordinary adds with regeneration without deadlock", async () => {
        await seedPlaylist(10);
        await installAddInsertGate(database);
        mockSelectLibraryRadioStationTracks.mockResolvedValue({
            tracks: tracks("replacement-1", REPLACEMENT_TRACK_COUNT),
        });

        try {
            const { results, firstResponse, secondResponse } =
                await runThreeWayMutations(blocker, database);
            expect(results.map((result) => result.status)).toEqual([
                "fulfilled",
                "fulfilled",
                "fulfilled",
            ]);
            expect([
                firstResponse.statusCode,
                secondResponse.statusCode,
            ]).toEqual([200, 200]);
            await expectConsistentThreeWayState(database);
        } finally {
            await removeAddInsertGate(database);
        }
    });
});
