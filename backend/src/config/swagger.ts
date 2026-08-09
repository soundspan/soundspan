import { readFileSync } from "node:fs";
import path from "node:path";
import swaggerJsdoc from "swagger-jsdoc";
import { config } from "../config";
import {
    BRAND_API_DESCRIPTION,
    BRAND_API_TITLE,
    BRAND_NAME,
    BRAND_SITE_URL,
} from "./brand";

function resolveApiVersion(): string {
    const manifestPath = path.join(__dirname, "..", "..", "package.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        version?: unknown;
    };
    if (typeof parsed.version !== "string" || parsed.version.length === 0) {
        throw new Error("backend package.json is missing a string version");
    }
    return parsed.version;
}

const API_VERSION = resolveApiVersion();

const options: swaggerJsdoc.Options = {
    definition: {
        openapi: "3.0.0",
        info: {
            title: BRAND_API_TITLE,
            version: API_VERSION,
            description: BRAND_API_DESCRIPTION,
            contact: {
                name: BRAND_NAME,
                url: BRAND_SITE_URL,
            },
        },
        servers: [
            {
                url: `http://localhost:${config.port}`,
                description: "Development server",
            },
        ],
        components: {
            securitySchemes: {
                sessionAuth: {
                    type: "apiKey",
                    in: "cookie",
                    name: "connect.sid",
                    description: "Session cookie authentication (web UI)",
                },
                apiKeyAuth: {
                    type: "apiKey",
                    in: "header",
                    name: "X-API-Key",
                    description: "API key authentication (client integrations)",
                },
            },
            schemas: {
                User: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        username: { type: "string" },
                        role: { type: "string", enum: ["user", "admin"] },
                        createdAt: { type: "string", format: "date-time" },
                    },
                },
                Artist: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        mbid: { type: "string" },
                        name: { type: "string" },
                        heroUrl: { type: "string", nullable: true },
                        summary: { type: "string", nullable: true },
                    },
                },
                Album: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        rgMbid: { type: "string" },
                        artistId: { type: "string" },
                        title: { type: "string" },
                        year: { type: "integer", nullable: true },
                        coverUrl: { type: "string", nullable: true },
                        primaryType: { type: "string" },
                    },
                },
                Track: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        albumId: { type: "string" },
                        title: { type: "string" },
                        trackNo: { type: "integer" },
                        duration: { type: "integer" },
                        filePath: { type: "string" },
                    },
                },
                ApiKey: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        lastUsed: { type: "string", format: "date-time" },
                        createdAt: { type: "string", format: "date-time" },
                    },
                },
                Error: {
                    type: "object",
                    properties: {
                        error: { type: "string" },
                    },
                },
            },
        },
        security: [{ sessionAuth: [] }, { apiKeyAuth: [] }],
    },
    apis: ["./src/routes/*.ts"],
};

export const swaggerSpec = swaggerJsdoc(options);
