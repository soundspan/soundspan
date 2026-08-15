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
import { safeResolvePath } from "../utils/safeResolvePath";

const ANONYMOUS_OPERATIONS = [
    ["/api/auth/login", "post"],
    ["/api/auth/logout", "post"],
    ["/api/auth/refresh", "post"],
    ["/api/auth/register", "post"],
    ["/api/onboarding/register", "post"],
    ["/api/onboarding/status", "get"],
    ["/api/device-link/verify", "post"],
    ["/api/device-link/status/{code}", "get"],
    ["/api/federation/v1/pair", "post"],
    ["/api/share-links/access/{token}", "get"],
    ["/api/share-links/access/{token}/stream/{trackId}", "get"],
    ["/api/share-links/access/{token}/zip", "get"],
    ["/api/share-links/access/{token}/cover", "get"],
    ["/health", "get"],
    ["/health/live", "get"],
    ["/health/ready", "get"],
    ["/api/health", "get"],
    ["/api/health/live", "get"],
    ["/api/health/ready", "get"],
    ["/api/podcasts/{id}/cover", "options"],
    ["/api/podcasts/{id}/cover", "get"],
    ["/api/podcasts/episodes/{episodeId}/cover", "options"],
    ["/api/podcasts/episodes/{episodeId}/cover", "get"],
    ["/api/webhooks/lidarr/verify", "get"],
] as const;

function resolveApiVersion(): string {
    const backendRoot = path.resolve(__dirname, "..", "..");
    const manifestPath = safeResolvePath(backendRoot, "package.json");
    if (!manifestPath) {
        throw new Error("backend package.json path escaped the backend root");
    }
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
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    bearerFormat: "JWT",
                    description: "Short-lived access token returned by login",
                },
                federationPeerAuth: {
                    type: "http",
                    scheme: "bearer",
                    bearerFormat: "opaque peer token",
                    description:
                        "Scoped federation peer credential issued by an administrator",
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
                LoginUser: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "username", "displayName", "role"],
                    properties: {
                        id: { type: "string" },
                        username: { type: "string" },
                        displayName: { type: "string", nullable: true },
                        role: { type: "string", enum: ["user", "admin"] },
                    },
                },
                LoginTokenResponse: {
                    type: "object",
                    additionalProperties: false,
                    required: ["token", "refreshToken", "user"],
                    properties: {
                        token: { type: "string" },
                        refreshToken: { type: "string" },
                        user: { $ref: "#/components/schemas/LoginUser" },
                    },
                },
                LoginTwoFactorChallenge: {
                    type: "object",
                    additionalProperties: false,
                    required: ["requires2FA", "message"],
                    properties: {
                        requires2FA: { type: "boolean", enum: [true] },
                        message: { type: "string" },
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
                        expiresAt: { type: "string", format: "date-time" },
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
        security: [{ sessionAuth: [] }, { bearerAuth: [] }, { apiKeyAuth: [] }],
    },
    apis: ["./src/routes/*.ts", "./src/routes/library/*.ts"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function applyAnonymousSecurity(document: object): void {
    if (!("paths" in document) || !isRecord(document.paths)) return;
    for (const [operationPath, method] of ANONYMOUS_OPERATIONS) {
        const pathItem = document.paths[operationPath];
        if (!isRecord(pathItem)) continue;
        const operation = pathItem[method];
        if (isRecord(operation)) {
            operation.security = [];
        }
    }
}

export const swaggerSpec = swaggerJsdoc(options);
applyAnonymousSecurity(swaggerSpec);
