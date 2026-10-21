jest.mock("../../config", () => ({ config: { port: 3006 } }));

const pkg = require("../../../package.json");

describe("openapi route sync", () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test("every documented path is namespaced under /api, /health or /rest", () => {
        const { swaggerSpec } = require("../swagger");
        const keys = Object.keys(swaggerSpec.paths || {});
        const bad = keys.filter((k) => !/^\/(api|health|rest)(\/|$)/.test(k));

        expect(bad).toEqual([]);
    });

    test("formerly un-prefixed endpoints are documented at their mounted /api keys", () => {
        const { swaggerSpec } = require("../swagger");
        const keys = [
            "/api/api-keys",
            "/api/api-keys/{id}",
            "/api/auth/login",
            "/api/auth/me",
            "/api/library/scan",
            "/api/lyrics/{trackId}",
            "/api/mixes",
            "/api/mixes/{id}",
            "/api/search",
            "/api/listen-together",
            "/api/listen-together/join",
        ];

        for (const key of keys) {
            expect(swaggerSpec.paths).toHaveProperty([key]);
        }
    });

    test("no un-prefixed phantom duplicates remain", () => {
        const { swaggerSpec } = require("../swagger");
        const keys = [
            "/auth/login",
            "/auth/me",
            "/api-keys",
            "/api-keys/{id}",
            "/library/scan",
            "/lyrics/{trackId}",
            "/mixes",
            "/mixes/{id}",
            "/search",
            "/listen-together",
        ];

        for (const key of keys) {
            expect(swaggerSpec.paths).not.toHaveProperty([key]);
        }
    });

    test("info.version tracks the backend package version", () => {
        const { swaggerSpec } = require("../swagger");

        expect(swaggerSpec.info.version).toBe(pkg.version);
        expect(swaggerSpec.info.version).not.toBe("1.0.0");
    });

    test("search documents the nullable remote track response shape", () => {
        const { swaggerSpec } = require("../swagger");
        const remoteTrackSchema =
            swaggerSpec.paths["/api/search"].get.responses["200"].content[
                "application/json"
            ].schema.properties.remoteTracks.items;

        expect(remoteTrackSchema).not.toHaveProperty("allOf");
        expect(remoteTrackSchema.required).toEqual(
            expect.arrayContaining([
                "albumId",
                "trackNo",
                "source",
                "streamSource",
                "album",
            ]),
        );
        expect(remoteTrackSchema.properties).toEqual(
            expect.objectContaining({
                albumId: { type: "string", nullable: true },
                trackNo: { type: "integer", nullable: true },
                source: { type: "string", enum: ["tidal", "youtube"] },
                streamSource: {
                    type: "string",
                    enum: ["tidal", "youtube"],
                },
                tidalTrackId: { type: "integer" },
                youtubeVideoId: { type: "string" },
                album: expect.objectContaining({
                    required: [
                        "id",
                        "title",
                        "rgMbid",
                        "matchedRgMbid",
                        "matchedInLibrary",
                        "coverArt",
                        "artist",
                    ],
                    properties: expect.objectContaining({
                        id: { type: "string", nullable: true },
                        title: { type: "string" },
                        rgMbid: { type: "string", nullable: true },
                        matchedRgMbid: expect.objectContaining({
                            type: "string",
                            nullable: true,
                        }),
                        matchedInLibrary: expect.objectContaining({
                            type: "boolean",
                        }),
                        coverArt: { type: "string", nullable: true },
                        artist: {
                            type: "object",
                            required: ["id", "name"],
                            properties: {
                                id: { type: "string", nullable: true },
                                name: { type: "string" },
                            },
                        },
                    }),
                }),
            }),
        );
    });

    test("search documents the per-user remote album response shape", () => {
        const { swaggerSpec } = require("../swagger");
        const remoteAlbumSchema =
            swaggerSpec.paths["/api/search"].get.responses["200"].content[
                "application/json"
            ].schema.properties.remoteAlbums;

        expect(remoteAlbumSchema.description).toContain("per user");
        expect(remoteAlbumSchema.description).toContain("uncached");
        expect(remoteAlbumSchema.items.required).toEqual([
            "id",
            "title",
            "artistId",
            "year",
            "coverUrl",
            "source",
            "remoteSources",
            "artist",
        ]);
        expect(remoteAlbumSchema.items.properties).toEqual(
            expect.objectContaining({
                source: { type: "string", enum: ["remote"] },
                remoteSources: {
                    type: "array",
                    items: { type: "string", enum: ["tidal", "youtube"] },
                },
                artist: {
                    type: "object",
                    required: ["id", "name", "mbid"],
                    properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        mbid: { type: "string" },
                    },
                },
            }),
        );
    });

    test("album detail documents matched library state", () => {
        const { swaggerSpec } = require("../swagger");
        const albumSchema =
            swaggerSpec.paths["/api/library/albums/{id}"].get.responses["200"]
                .content["application/json"].schema;

        expect(albumSchema.description).toBe(
            "Album record with tracks, owned state, source, and cover; only streaming-match fields are listed below.",
        );
        expect(albumSchema.properties).toEqual(
            expect.objectContaining({
                matchedRgMbid: expect.objectContaining({
                    type: "string",
                    nullable: true,
                }),
                matchedInLibrary: expect.objectContaining({
                    type: "boolean",
                }),
            }),
        );
    });
});
