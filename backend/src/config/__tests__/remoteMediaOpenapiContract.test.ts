jest.mock("../../config", () => ({ config: { port: 3006 } }));

type PropertySchema = {
    type?: "array" | "boolean" | "integer" | "number" | "object" | "string";
    minimum?: number;
    minLength?: number;
    maxLength?: number;
    items?: PropertySchema;
};

type RequestSchema = {
    required?: string[];
    properties?: Record<string, PropertySchema>;
    oneOf?: RequestSchema[];
    anyOf?: RequestSchema[];
    not?: { anyOf?: RequestSchema[] };
};

function hasRequiredFields(
    schema: RequestSchema,
    payload: Record<string, unknown>,
): boolean {
    return (schema.required ?? []).every(
        (field) => payload[field] !== undefined,
    );
}

function matchesScalarProperty(
    schema: PropertySchema,
    value: unknown,
): boolean {
    if (schema.type === "integer") {
        return (
            typeof value === "number" &&
            Number.isInteger(value) &&
            (schema.minimum === undefined || value >= schema.minimum)
        );
    }
    if (schema.type === "string") {
        return (
            typeof value === "string" &&
            (schema.minLength === undefined ||
                value.length >= schema.minLength) &&
            (schema.maxLength === undefined || value.length <= schema.maxLength)
        );
    }
    if (schema.type === "boolean") return typeof value === "boolean";
    return true;
}

function matchesProperty(schema: PropertySchema, value: unknown): boolean {
    if (schema.type !== "array") return matchesScalarProperty(schema, value);
    if (!Array.isArray(value)) return false;
    return value.every((entry) =>
        schema.items ? matchesScalarProperty(schema.items, entry) : true,
    );
}

function matchesVariant(
    schema: RequestSchema,
    payload: Record<string, unknown>,
): boolean {
    if (!hasRequiredFields(schema, payload)) return false;
    if (
        schema.not?.anyOf?.some((excluded) =>
            hasRequiredFields(excluded, payload),
        )
    ) {
        return false;
    }
    return Object.entries(payload).every(([field, value]) => {
        const propertySchema = schema.properties?.[field];
        return propertySchema ? matchesProperty(propertySchema, value) : true;
    });
}

function acceptsOneOf(
    schema: RequestSchema,
    payload: Record<string, unknown>,
): boolean {
    return (
        schema.oneOf?.filter((variant) => matchesVariant(variant, payload))
            .length === 1
    );
}

function acceptsAnyOf(
    schema: RequestSchema,
    payload: Record<string, unknown>,
): boolean {
    const matchesAlternative = schema.anyOf?.some((alternative) =>
        hasRequiredFields(alternative, payload),
    );
    return Boolean(matchesAlternative && matchesVariant(schema, payload));
}

function requestSchema(path: string, method: "post" | "put"): RequestSchema {
    const { swaggerSpec } = require("../swagger");
    const schema = swaggerSpec.paths?.[path]?.[method]?.requestBody?.content?.[
        "application/json"
    ]?.schema as RequestSchema | undefined;

    expect(schema).toBeDefined();
    return schema as RequestSchema;
}

function variantProperties(
    schema: RequestSchema,
    identifier: string,
): string[] {
    const variant = schema.oneOf?.find((candidate) =>
        candidate.required?.includes(identifier),
    );
    expect(variant).toBeDefined();
    return Object.keys(variant?.properties ?? {});
}

const tidalRequest = {
    tidalTrackId: 991,
    title: "TIDAL Song",
    artist: "TIDAL Artist",
    album: "TIDAL Album",
    duration: 245,
};

const youtubeRequest = {
    youtubeVideoId: "video-7",
    title: "YouTube Song",
    artist: "YouTube Artist",
    album: "YouTube Album",
    duration: 199,
    thumbnailUrl: "https://img.example/video-7.jpg",
};

describe("remote-media OpenAPI request contracts", () => {
    test("playlist add exposes every supported remote-media field", () => {
        const schema = requestSchema("/api/playlists/{id}/items", "post");
        const remoteFields = [
            "title",
            "artist",
            "album",
            "duration",
            "isrc",
            "quality",
            "explicit",
            "thumbnailUrl",
        ];

        expect(variantProperties(schema, "tidalTrackId")).toEqual(
            expect.arrayContaining(["tidalTrackId", ...remoteFields]),
        );
        expect(variantProperties(schema, "youtubeVideoId")).toEqual(
            expect.arrayContaining(["youtubeVideoId", ...remoteFields]),
        );
    });

    test.each([
        ["local", { trackId: "track-1" }, true],
        ["TIDAL", tidalRequest, true],
        ["YouTube", youtubeRequest, true],
        ["missing remote metadata", { tidalTrackId: 991 }, false],
        ["no identifier", { title: "No ID" }, false],
        [
            "conflicting identifiers",
            { trackId: "track-1", ...tidalRequest },
            false,
        ],
    ])("playlist add documents the %s request", (_label, payload, accepted) => {
        const schema = requestSchema("/api/playlists/{id}/items", "post");

        expect(acceptsOneOf(schema, payload)).toBe(accepted);
    });

    test.each([
        ["local", { trackId: "track-1" }, true],
        ["TIDAL", tidalRequest, true],
        ["YouTube", youtubeRequest, true],
        ["missing remote metadata", { youtubeVideoId: "video-7" }, false],
        ["no identifier", {}, false],
        [
            "conflicting identifiers",
            { youtubeVideoId: "video-7", ...tidalRequest },
            false,
        ],
    ])("play logging documents the %s request", (_label, payload, accepted) => {
        const schema = requestSchema("/api/plays", "post");

        expect(acceptsOneOf(schema, payload)).toBe(accepted);
    });

    test("play logging exposes required remote metadata and thumbnails", () => {
        const schema = requestSchema("/api/plays", "post");
        const remoteFields = [
            "title",
            "artist",
            "album",
            "duration",
            "thumbnailUrl",
        ];

        expect(variantProperties(schema, "tidalTrackId")).toEqual(
            expect.arrayContaining(["tidalTrackId", ...remoteFields]),
        );
        expect(variantProperties(schema, "youtubeVideoId")).toEqual(
            expect.arrayContaining(["youtubeVideoId", ...remoteFields]),
        );
    });

    test.each([
        ["mixed-source item IDs", { itemIds: ["item-2", "item-1"] }, true],
        ["legacy local track IDs", { trackIds: ["track-2", "track-1"] }, true],
        [
            "both arrays with item IDs preferred",
            { itemIds: ["item-2"], trackIds: ["track-2"] },
            true,
        ],
        ["neither array", {}, false],
        ["invalid item IDs", { itemIds: "item-1" }, false],
    ])("playlist reorder documents %s", (_label, payload, accepted) => {
        const schema = requestSchema(
            "/api/playlists/{id}/items/reorder",
            "put",
        );

        expect(acceptsAnyOf(schema, payload)).toBe(accepted);
    });
});
