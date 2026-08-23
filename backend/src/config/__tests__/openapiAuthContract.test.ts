jest.mock("../../config", () => ({ config: { port: 3006 } }));

type HttpMethod = "get" | "post" | "delete" | "options";

interface AuthExpectation {
    method: HttpMethod;
    path: string;
    anonymous: boolean;
}

const AUTH_MATRIX: AuthExpectation[] = [
    { method: "post", path: "/api/auth/login", anonymous: true },
    { method: "post", path: "/api/auth/logout", anonymous: true },
    { method: "post", path: "/api/auth/refresh", anonymous: true },
    { method: "post", path: "/api/auth/register", anonymous: true },
    { method: "post", path: "/api/onboarding/register", anonymous: true },
    { method: "get", path: "/api/onboarding/status", anonymous: true },
    {
        method: "get",
        path: "/api/share-links/access/{token}",
        anonymous: true,
    },
    {
        method: "get",
        path: "/api/share-links/access/{token}/stream/{trackId}",
        anonymous: true,
    },
    {
        method: "get",
        path: "/api/share-links/access/{token}/zip",
        anonymous: true,
    },
    {
        method: "get",
        path: "/api/share-links/access/{token}/cover",
        anonymous: true,
    },
    { method: "post", path: "/api/device-link/verify", anonymous: true },
    {
        method: "get",
        path: "/api/device-link/status/{code}",
        anonymous: true,
    },
    { method: "get", path: "/health", anonymous: true },
    { method: "get", path: "/health/live", anonymous: true },
    { method: "get", path: "/health/ready", anonymous: true },
    { method: "get", path: "/api/health", anonymous: true },
    { method: "get", path: "/api/health/live", anonymous: true },
    { method: "get", path: "/api/health/ready", anonymous: true },
    {
        method: "options",
        path: "/api/podcasts/{id}/cover",
        anonymous: true,
    },
    {
        method: "get",
        path: "/api/podcasts/{id}/cover",
        anonymous: true,
    },
    {
        method: "options",
        path: "/api/podcasts/episodes/{episodeId}/cover",
        anonymous: true,
    },
    {
        method: "get",
        path: "/api/podcasts/episodes/{episodeId}/cover",
        anonymous: true,
    },
    {
        method: "get",
        path: "/api/webhooks/lidarr/verify",
        anonymous: true,
    },
    { method: "get", path: "/api/federation/v1/manifest", anonymous: false },
    { method: "get", path: "/api/auth/me", anonymous: false },
    { method: "post", path: "/api/api-keys", anonymous: false },
    { method: "post", path: "/api/onboarding/complete", anonymous: false },
    { method: "post", path: "/api/share-links", anonymous: false },
];

const INTERACTIVE_MANAGEMENT_OPERATIONS = [
    ["post", "/api/api-keys"],
    ["delete", "/api/api-keys/{id}"],
    ["post", "/api/auth/2fa/setup"],
    ["post", "/api/auth/2fa/enable"],
    ["post", "/api/auth/2fa/disable"],
] as const;

function operationSecurity(spec: any, expectation: AuthExpectation): unknown {
    const operation = spec.paths?.[expectation.path]?.[expectation.method];
    if (!operation) {
        throw new Error(
            `Missing OpenAPI operation: ${expectation.method.toUpperCase()} ${expectation.path}`,
        );
    }
    return operation.security ?? spec.security;
}

describe("OpenAPI authentication contract", () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test("matches the runtime anonymous/protected operation matrix", () => {
        const { swaggerSpec } = require("../swagger");

        for (const expectation of AUTH_MATRIX) {
            const security = operationSecurity(swaggerSpec, expectation);
            if (expectation.anonymous) {
                expect(security).toEqual([]);
            } else {
                expect(security).not.toEqual([]);
            }
        }
    });

    test("documents both runtime login success shapes", () => {
        const { swaggerSpec } = require("../swagger");
        const responseSchema =
            swaggerSpec.paths["/api/auth/login"].post.responses["200"].content[
                "application/json"
            ].schema;

        expect(responseSchema.oneOf).toEqual([
            { $ref: "#/components/schemas/LoginTokenResponse" },
            { $ref: "#/components/schemas/LoginTwoFactorChallenge" },
        ]);
        expect(swaggerSpec.components.schemas.LoginTokenResponse).toEqual(
            expect.objectContaining({
                required: ["token", "refreshToken", "user"],
            }),
        );
        expect(swaggerSpec.components.schemas.LoginTwoFactorChallenge).toEqual(
            expect.objectContaining({
                required: ["requires2FA", "message"],
                properties: expect.objectContaining({
                    requires2FA: expect.objectContaining({ enum: [true] }),
                }),
            }),
        );
    });

    test("exactly documents the three OIDC POST operation contracts", () => {
        const { swaggerSpec } = require("../swagger");
        const operations = swaggerSpec.paths;

        expect(operations["/api/auth/oidc/exchange"].post).toEqual({
            summary: "Exchange a one-time OIDC code for login tokens",
            tags: ["Authentication"],
            security: [],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["code"],
                            properties: {
                                code: {
                                    type: "string",
                                    minLength: 1,
                                    maxLength: 256,
                                    pattern: "^[A-Za-z0-9_-]+$",
                                },
                            },
                        },
                    },
                },
            },
            responses: {
                200: {
                    description: "Login tokens and user",
                    content: {
                        "application/json": {
                            schema: {
                                $ref: "#/components/schemas/LoginTokenResponse",
                            },
                        },
                    },
                },
                400: { description: "Invalid request" },
                401: { description: "Invalid or expired code" },
            },
        });
        expect(operations["/api/auth/oidc/confirm-link"].post).toEqual({
            summary: "Confirm an OIDC account link with local credentials",
            tags: ["Authentication"],
            security: [],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["linkToken", "password"],
                            properties: {
                                linkToken: {
                                    type: "string",
                                    minLength: 1,
                                    maxLength: 256,
                                    pattern: "^[A-Za-z0-9_-]+$",
                                },
                                password: {
                                    type: "string",
                                    format: "password",
                                    minLength: 1,
                                },
                                twoFactorToken: {
                                    type: "string",
                                    minLength: 1,
                                },
                            },
                        },
                    },
                },
            },
            responses: {
                200: {
                    description: "Login response or 2FA challenge",
                    content: {
                        "application/json": {
                            schema: {
                                oneOf: [
                                    {
                                        $ref: "#/components/schemas/LoginTokenResponse",
                                    },
                                    {
                                        $ref: "#/components/schemas/LoginTwoFactorChallenge",
                                    },
                                ],
                            },
                        },
                    },
                },
                400: { description: "Invalid request" },
                401: { description: "Invalid credentials or link" },
                500: { description: "Failed to link OIDC account" },
            },
        });
        expect(operations["/api/auth/oidc/redeem-invite"].post).toEqual({
            summary: "Redeem an invite for OIDC account provisioning",
            tags: ["Authentication"],
            security: [],
            requestBody: {
                required: true,
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["inviteToken", "inviteCode"],
                            properties: {
                                inviteToken: {
                                    type: "string",
                                    minLength: 1,
                                    maxLength: 256,
                                    pattern: "^[A-Za-z0-9_-]+$",
                                },
                                inviteCode: {
                                    type: "string",
                                    minLength: 1,
                                },
                            },
                        },
                    },
                },
            },
            responses: {
                200: {
                    description: "Login tokens and provisioned user",
                    content: {
                        "application/json": {
                            schema: {
                                $ref: "#/components/schemas/LoginTokenResponse",
                            },
                        },
                    },
                },
                400: { description: "Invalid invite code" },
                401: { description: "Invalid or expired invite" },
                500: { description: "Failed to redeem OIDC invite" },
            },
        });
    });

    test("excludes API keys from interactive credential-management operations", () => {
        const { swaggerSpec } = require("../swagger");

        for (const [method, path] of INTERACTIVE_MANAGEMENT_OPERATIONS) {
            expect(swaggerSpec.paths[path][method].security).toEqual([
                { bearerAuth: [] },
            ]);
        }
    });
});
