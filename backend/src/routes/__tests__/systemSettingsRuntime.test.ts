import axios from "axios";
import { Request, Response } from "express";

type AuthFailureMode = "ok" | "unauthorized" | "forbidden";
const authFailureState = { mode: "ok" as AuthFailureMode };
const mockQueueCleanerLogError = jest.fn();

const mockRequireAuth = jest.fn(
    async (_req: Request, res: Response, next: () => void) => {
        if (authFailureState.mode === "unauthorized") {
            return res.status(401).json({ error: "Unauthorized" });
        }
        return next();
    },
);

const mockRequireAdmin = jest.fn(
    async (_req: Request, res: Response, next: () => void) => {
        if (authFailureState.mode === "forbidden") {
            return res.status(403).json({ error: "Forbidden" });
        }
        return next();
    },
);

jest.mock("../../middleware/auth", () => ({
    requireAuth: mockRequireAuth,
    requireAdmin: mockRequireAdmin,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(() => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: mockQueueCleanerLogError,
        })),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        systemSettings: {
            findUnique: jest.fn(),
            create: jest.fn(),
            upsert: jest.fn(),
        },
        audiobookProgress: {
            deleteMany: jest.fn(),
        },
    },
}));

jest.mock("../../utils/envWriter", () => {
    class EnvFileSyncSkippedError extends Error {}
    return {
        EnvFileSyncSkippedError,
        writeEnvFile: jest.fn(),
    };
});

jest.mock("../../utils/systemSettings", () => ({
    invalidateSystemSettingsCache: jest.fn(),
}));

const mockSchedulerJobGetState = jest.fn();
const mockSchedulerJobRemove = jest.fn();
const mockSchedulerJob = {
    id: "scheduler:reconciliation:on-demand",
    getState: mockSchedulerJobGetState,
    remove: mockSchedulerJobRemove,
};
const mockSchedulerQueueAdd = jest.fn();
const mockSchedulerQueueGetJob = jest.fn();
jest.mock("../../workers/queues", () => ({
    schedulerQueue: {
        add: (...args: unknown[]) => mockSchedulerQueueAdd(...args),
        getJob: (...args: unknown[]) => mockSchedulerQueueGetJob(...args),
    },
}));

jest.mock("../../utils/encryption", () => ({
    encrypt: jest.fn((value: string) => `enc:${value}`),
    decrypt: jest.fn((value: string) => `dec:${value}`),
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        refreshApiKey: jest.fn(),
    },
}));

jest.mock("../../services/soulseek", () => ({
    soulseekService: {
        disconnect: jest.fn(),
    },
}));

jest.mock("../../services/tidal", () => ({
    tidalService: {
        isSidecarHealthy: jest.fn(),
        verifySession: jest.fn(),
        initiateDeviceAuth: jest.fn(),
        pollDeviceAuth: jest.fn(),
        saveTokens: jest.fn(),
    },
}));

jest.mock("../../services/notificationService", () => ({
    notificationService: {
        notifySystem: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        keys: jest.fn(),
        del: jest.fn(),
    },
}));

jest.mock("axios");

const mockSlskClient = {
    connect: jest.fn(),
};

jest.mock("slsk-client", () => mockSlskClient);

const mockSoulseekService = {
    disconnect: jest.fn(),
};
let throwSoulseekImport = false;

jest.mock("../../services/soulseek", () => ({
    get soulseekService() {
        if (throwSoulseekImport) {
            throw new Error("Soulseek service mock import failure");
        }
        return mockSoulseekService;
    },
}));

jest.mock("../../config", () => ({
    config: { soundspanCallbackUrl: "http://backend:3006" },
}));

import router from "../systemSettings";
import { prisma } from "../../utils/db";
import { writeEnvFile, EnvFileSyncSkippedError } from "../../utils/envWriter";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { decrypt } from "../../utils/encryption";
import { lastFmService } from "../../services/lastfm";
import { tidalService } from "../../services/tidal";
import { notificationService } from "../../services/notificationService";
import { redisClient } from "../../utils/redis";

const mockSystemSettingsFindUnique = prisma.systemSettings
    .findUnique as unknown as jest.Mock;
const mockSystemSettingsCreate = prisma.systemSettings
    .create as unknown as jest.Mock;
const mockSystemSettingsUpsert = prisma.systemSettings
    .upsert as unknown as jest.Mock;
const mockAudiobookProgressDeleteMany = prisma.audiobookProgress
    .deleteMany as unknown as jest.Mock;
const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosPut = axios.put as jest.Mock;
const mockWriteEnvFile = writeEnvFile as jest.Mock;
const mockInvalidateSystemSettingsCache =
    invalidateSystemSettingsCache as jest.Mock;
const mockDecrypt = decrypt as jest.Mock;
const mockLastFmService = lastFmService as jest.Mocked<typeof lastFmService>;
const mockTidalService = tidalService as jest.Mocked<typeof tidalService>;
const mockNotificationService = notificationService as jest.Mocked<
    typeof notificationService
>;
const mockRedisClient = redisClient as jest.Mocked<typeof redisClient>;
const mockSlskClientConnect = mockSlskClient.connect as jest.Mock;

function getRouteHandler(
    path: string,
    method: "get" | "post" | "patch" | "delete",
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

const authMiddleware = (router as any).stack[0].handle;
const adminMiddleware = (router as any).stack[1].handle;

async function runWithAuth(req: any, res: any, handler: () => Promise<void>) {
    await authMiddleware(req, res, async () => {
        await adminMiddleware(req, res, async () => {
            await handler();
        });
    });
}

describe("systemSettings runtime routes", () => {
    const getSettingsHandler = getRouteHandler("/", "get");
    const postSettingsHandler = getRouteHandler("/", "post");
    const testLidarrHandler = getRouteHandler("/test-lidarr", "post");
    const testOpenAiHandler = getRouteHandler("/test-openai", "post");
    const testFanartHandler = getRouteHandler("/test-fanart", "post");
    const testLastfmHandler = getRouteHandler("/test-lastfm", "post");
    const testSoulseekHandler = getRouteHandler("/test-soulseek", "post");
    const testAudiobookshelfHandler = getRouteHandler(
        "/test-audiobookshelf",
        "post",
    );
    const testSpotifyHandler = getRouteHandler("/test-spotify", "post");
    const testTidalHandler = getRouteHandler("/test-tidal", "post");
    const tidalDeviceHandler = getRouteHandler("/tidal-auth/device", "post");
    const tidalTokenHandler = getRouteHandler("/tidal-auth/token", "post");
    const queueStatusHandler = getRouteHandler("/queue-cleaner-status", "get");
    const queueStartHandler = getRouteHandler("/queue-cleaner/start", "post");
    const queueStopHandler = getRouteHandler("/queue-cleaner/stop", "post");
    const clearCachesHandler = getRouteHandler("/clear-caches", "post");

    beforeEach(() => {
        jest.clearAllMocks();
        throwSoulseekImport = false;
        authFailureState.mode = "ok";
        mockSystemSettingsFindUnique.mockResolvedValue({
            id: "default",
            lidarrApiKey: "lidarr-api",
            lidarrWebhookSecret: "lidarr-webhook",
            openaiApiKey: "openai-api",
            fanartApiKey: "fanart-api",
            lastfmApiKey: "lastfm-api",
            audiobookshelfApiKey: "abs-api",
            soulseekPassword: "slsk-pass",
            spotifyClientId: "spotify-client",
            spotifyClientSecret: "spotify-secret",
            tidalAccessToken: "tidal-access",
            tidalRefreshToken: "tidal-refresh",
            ytMusicClientSecret: "yt-secret",
        } as any);
        mockSystemSettingsCreate.mockResolvedValue({
            id: "default",
            lidarrApiKey: null,
            lidarrWebhookSecret: null,
            openaiApiKey: null,
            fanartApiKey: null,
            lastfmApiKey: null,
            audiobookshelfApiKey: null,
            soulseekPassword: null,
            spotifyClientSecret: null,
            tidalAccessToken: null,
            tidalRefreshToken: null,
            ytMusicClientSecret: null,
        } as any);
        mockSystemSettingsUpsert.mockResolvedValue({ id: "default" } as any);
        mockAudiobookProgressDeleteMany.mockResolvedValue({ count: 2 } as any);
        mockWriteEnvFile.mockResolvedValue(undefined);
        mockDecrypt.mockImplementation((value: string) => `dec:${value}`);
        mockLastFmService.refreshApiKey.mockResolvedValue(undefined as any);
        mockSoulseekService.disconnect.mockReturnValue(undefined as any);
        mockSchedulerQueueAdd.mockResolvedValue(mockSchedulerJob);
        mockSchedulerQueueGetJob.mockResolvedValue(null);
        mockSchedulerJobGetState.mockResolvedValue("waiting");
        mockSchedulerJobRemove.mockResolvedValue(undefined);
        mockTidalService.isSidecarHealthy.mockResolvedValue(true);
        mockTidalService.verifySession.mockResolvedValue({
            valid: true,
            userId: "tidal-user",
        } as any);
        mockTidalService.initiateDeviceAuth.mockResolvedValue({
            deviceCode: "device-code",
            userCode: "ABCD",
            verificationUri: "https://verify.example",
        } as any);
        mockTidalService.pollDeviceAuth.mockResolvedValue({
            access_token: "acc",
            refresh_token: "ref",
            user_id: "u1",
            country_code: "US",
            username: "tidal-username",
        } as any);
        mockTidalService.saveTokens.mockResolvedValue(undefined as any);
        mockNotificationService.notifySystem.mockResolvedValue(
            undefined as any,
        );
        mockRedisClient.keys.mockResolvedValue([]);
        mockRedisClient.del.mockResolvedValue(1 as any);
        mockAxiosGet.mockResolvedValue({ data: { version: "2.0.0" } });
        mockAxiosPost.mockResolvedValue({ data: { model: "gpt-4o-mini" } });
        mockAxiosPut.mockResolvedValue({ data: {} });
        mockSlskClientConnect.mockImplementation(
            (
                _options: Record<string, unknown>,
                cb: (err: Error | null, client: unknown) => void,
            ) => {
                cb(null, {});
            },
        );
    });

    it("returns decrypted settings and handles decryption failures safely", async () => {
        mockDecrypt.mockImplementation((value: string) => {
            if (value === "fanart-api") {
                throw new Error("corrupt ciphertext");
            }
            return `dec:${value}`;
        });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await getSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.lidarrApiKey).toBe("dec:lidarr-api");
        expect(res.body.fanartApiKey).toBeNull();
    });

    it("never returns TIDAL token material and reports tidalConnected instead", async () => {
        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await getSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).not.toHaveProperty("tidalAccessToken");
        expect(res.body).not.toHaveProperty("tidalRefreshToken");
        expect(res.body.tidalConnected).toBe(true);
    });

    it("never returns stored Spotify credential fields", async () => {
        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await getSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).not.toHaveProperty("spotifyClientId");
        expect(res.body).not.toHaveProperty("spotifyClientSecret");
    });

    it("reports tidalConnected=false when stored tokens are missing", async () => {
        mockSystemSettingsFindUnique.mockResolvedValueOnce({
            id: "default",
            tidalAccessToken: null,
            tidalRefreshToken: null,
        } as any);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await getSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.tidalConnected).toBe(false);
        expect(res.body).not.toHaveProperty("tidalAccessToken");
        expect(res.body).not.toHaveProperty("tidalRefreshToken");
    });

    it("treats empty-string secrets as no-change so a settings round-trip cannot wipe stored credentials", async () => {
        const req = {
            user: { id: "admin-1" },
            body: {
                lidarrEnabled: true,
                lidarrUrl: "http://lidarr:8686",
                lidarrApiKey: "",
                lidarrWebhookSecret: "",
                openaiApiKey: "",
                fanartApiKey: "",
                lastfmApiKey: "",
                audiobookshelfApiKey: "",
                soulseekPassword: "",
                ytMusicClientSecret: "",
                transcodeCacheMaxGb: 12,
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        const upsertArg = mockSystemSettingsUpsert.mock.calls[0][0];
        for (const field of [
            "lidarrApiKey",
            "lidarrWebhookSecret",
            "openaiApiKey",
            "fanartApiKey",
            "lastfmApiKey",
            "audiobookshelfApiKey",
            "soulseekPassword",
            "ytMusicClientSecret",
        ]) {
            expect(upsertArg.update).not.toHaveProperty(field);
        }
        // Non-secret fields still save normally
        expect(upsertArg.update.lidarrEnabled).toBe(true);
        expect(upsertArg.update.lidarrUrl).toBe("http://lidarr:8686");
        expect(upsertArg.update.transcodeCacheMaxGb).toBe(12);
    });

    it("accepts youtube as a download source and fallback", async () => {
        const req = {
            user: { id: "admin-1" },
            body: {
                downloadSource: "youtube",
                primaryFailureFallback: "youtube",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockSystemSettingsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({
                    downloadSource: "youtube",
                    primaryFailureFallback: "youtube",
                }),
            }),
        );
    });

    it("env sync and webhook config use stored secrets when the form round-trips empty strings", async () => {
        mockSystemSettingsUpsert.mockResolvedValueOnce({
            id: "default",
            lidarrApiKey: "stored-lidarr-key",
            fanartApiKey: "stored-fanart-key",
            openaiApiKey: "stored-openai-key",
            audiobookshelfApiKey: "stored-abs-key",
        } as any);
        mockAxiosGet.mockResolvedValueOnce({ data: [] });

        const req = {
            user: { id: "admin-1" },
            body: {
                lidarrEnabled: true,
                lidarrUrl: "http://lidarr:8686",
                lidarrApiKey: "",
                fanartApiKey: "",
                openaiApiKey: "",
                audiobookshelfApiKey: "",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockWriteEnvFile).toHaveBeenCalledWith(
            expect.objectContaining({
                LIDARR_API_KEY: "dec:stored-lidarr-key",
                FANART_API_KEY: "dec:stored-fanart-key",
                OPENAI_API_KEY: "dec:stored-openai-key",
                AUDIOBOOKSHELF_API_KEY: "dec:stored-abs-key",
            }),
        );
        // Webhook auto-config runs with the stored key, not the empty form value
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "http://lidarr:8686/api/v1/notification",
            expect.objectContaining({
                headers: { "X-Api-Key": "dec:stored-lidarr-key" },
            }),
        );
    });

    it("preserves omitted environment settings during a partial update", async () => {
        const req = {
            user: { id: "admin-1" },
            body: { lidarrUrl: "http://new-lidarr:8686" },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockWriteEnvFile).toHaveBeenCalledWith({
            LIDARR_ENABLED: undefined,
            LIDARR_URL: "http://new-lidarr:8686",
            LIDARR_API_KEY: undefined,
            FANART_API_KEY: undefined,
            OPENAI_API_KEY: undefined,
            AUDIOBOOKSHELF_URL: undefined,
            AUDIOBOOKSHELF_API_KEY: undefined,
        });
    });

    it("env sync clears secrets only on explicit null", async () => {
        mockSystemSettingsUpsert.mockResolvedValueOnce({
            id: "default",
            openaiApiKey: null,
        } as any);

        const req = {
            user: { id: "admin-1" },
            body: { openaiApiKey: null },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockWriteEnvFile).toHaveBeenCalledWith({
            LIDARR_ENABLED: undefined,
            LIDARR_URL: undefined,
            LIDARR_API_KEY: undefined,
            FANART_API_KEY: undefined,
            OPENAI_API_KEY: null,
            AUDIOBOOKSHELF_URL: undefined,
            AUDIOBOOKSHELF_API_KEY: undefined,
        });
    });

    it("writes every environment setting supplied by a full update", async () => {
        const req = {
            user: { id: "admin-1" },
            body: {
                lidarrEnabled: false,
                lidarrUrl: "http://lidarr:8686",
                lidarrApiKey: "new-lidarr-key",
                fanartApiKey: "new-fanart-key",
                openaiApiKey: "new-openai-key",
                audiobookshelfUrl: "http://audiobookshelf:13378",
                audiobookshelfApiKey: "new-audiobookshelf-key",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockWriteEnvFile).toHaveBeenCalledWith({
            LIDARR_ENABLED: "false",
            LIDARR_URL: "http://lidarr:8686",
            LIDARR_API_KEY: "new-lidarr-key",
            FANART_API_KEY: "new-fanart-key",
            OPENAI_API_KEY: "new-openai-key",
            AUDIOBOOKSHELF_URL: "http://audiobookshelf:13378",
            AUDIOBOOKSHELF_API_KEY: "new-audiobookshelf-key",
        });
    });

    it("clears a stored secret only on an explicit null", async () => {
        const req = {
            user: { id: "admin-1" },
            body: {
                openaiApiKey: null,
                lidarrApiKey: "",
                soulseekPassword: "new-pass",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        const upsertArg = mockSystemSettingsUpsert.mock.calls[0][0];
        expect(upsertArg.update.openaiApiKey).toBeNull();
        expect(upsertArg.update).not.toHaveProperty("lidarrApiKey");
        expect(upsertArg.update.soulseekPassword).toBe("enc:new-pass");
    });

    it("ignores TIDAL credential fields on save so a settings round-trip cannot wipe the admin connection", async () => {
        const req = {
            user: { id: "admin-1" },
            body: {
                tidalEnabled: true,
                tidalCountryCode: "US",
                tidalAccessToken: "",
                tidalRefreshToken: "",
                tidalUserId: "",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        const upsertArg = mockSystemSettingsUpsert.mock.calls[0][0];
        expect(upsertArg.update).not.toHaveProperty("tidalAccessToken");
        expect(upsertArg.update).not.toHaveProperty("tidalRefreshToken");
        expect(upsertArg.update).not.toHaveProperty("tidalUserId");
        expect(upsertArg.update.tidalEnabled).toBe(true);
        expect(upsertArg.update.tidalCountryCode).toBe("US");
    });

    it("strips obsolete Spotify credential fields from settings updates", async () => {
        const req = {
            user: { id: "admin-1" },
            body: {
                spotifyClientId: "obsolete-client",
                spotifyClientSecret: "obsolete-secret",
                showVersion: true,
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        const upsertArg = mockSystemSettingsUpsert.mock.calls[0][0];
        expect(upsertArg.update).not.toHaveProperty("spotifyClientId");
        expect(upsertArg.update).not.toHaveProperty("spotifyClientSecret");
        expect(upsertArg.update.showVersion).toBe(true);
    });

    it("creates defaults when settings do not exist", async () => {
        mockSystemSettingsFindUnique.mockResolvedValueOnce(null);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await getSettingsHandler(req, res);

        expect(mockSystemSettingsCreate).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.id).toBe("default");
    });

    it("saves settings, encrypts secrets, and updates webhook when Lidarr is enabled", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: [
                {
                    id: 9,
                    implementation: "Webhook",
                    name: "soundspan",
                    fields: [{ name: "url", value: "http://old/lidarr" }],
                },
            ],
        });

        const req = {
            user: { id: "admin-1" },
            body: {
                lidarrEnabled: true,
                lidarrUrl: "http://lidarr:8686",
                lidarrApiKey: "lidarr-key",
                lidarrWebhookSecret: "lidarr-webhook-secret",
                openaiApiKey: "openai-key",
                lastfmApiKey: "lastfm-key",
                audiobookshelfApiKey: "audiobookshelf-key",
                tidalAccessToken: "tidal-access-token",
                tidalRefreshToken: "tidal-refresh-token",
                soulseekUsername: "slsk-user",
                soulseekPassword: "slsk-pass",
                fanartApiKey: "fanart-key",
                audiobookshelfEnabled: false,
                ytMusicClientSecret: "yt-secret",
                transcodeCacheMaxGb: 12,
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(mockSystemSettingsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({
                    lidarrApiKey: "enc:lidarr-key",
                    lidarrWebhookSecret: "enc:lidarr-webhook-secret",
                    openaiApiKey: "enc:openai-key",
                    lastfmApiKey: "enc:lastfm-key",
                    audiobookshelfApiKey: "enc:audiobookshelf-key",
                    soulseekPassword: "enc:slsk-pass",
                    fanartApiKey: "enc:fanart-key",
                    ytMusicClientSecret: "enc:yt-secret",
                }),
            }),
        );
        // TIDAL credentials are managed exclusively by the /tidal-auth flow
        const savedUpdate = mockSystemSettingsUpsert.mock.calls[0][0].update;
        expect(savedUpdate).not.toHaveProperty("tidalAccessToken");
        expect(savedUpdate).not.toHaveProperty("tidalRefreshToken");
        expect(mockInvalidateSystemSettingsCache).toHaveBeenCalled();
        expect(mockWriteEnvFile).toHaveBeenCalled();
        expect(mockLastFmService.refreshApiKey).toHaveBeenCalled();
        expect(mockSoulseekService.disconnect).toHaveBeenCalled();
        expect(mockAudiobookProgressDeleteMany).toHaveBeenCalled();
        expect(mockAxiosPut).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.requiresRestart).toBe(true);
    });

    it("creates a Lidarr webhook when no existing webhook is found", async () => {
        mockAxiosGet.mockResolvedValueOnce({ data: [] });

        const req = {
            user: { id: "admin-1" },
            body: {
                lidarrEnabled: true,
                lidarrUrl: "http://lidarr:8686",
                lidarrApiKey: "lidarr-key",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(mockAxiosPost).toHaveBeenCalled();
        expect(mockAxiosPut).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("matches an existing webhook by URL pattern", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: [
                {
                    id: 15,
                    implementation: "Webhook",
                    name: "Legacy Hook",
                    fields: [
                        {
                            name: "url",
                            value: "https://old/api/webhooks/lidarr",
                        },
                    ],
                },
            ],
        });

        const req = {
            user: { id: "admin-1" },
            body: {
                lidarrEnabled: true,
                lidarrUrl: "http://lidarr:8686",
                lidarrApiKey: "lidarr-key",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(mockAxiosPut).toHaveBeenCalled();
        expect(mockAxiosPost).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("continues saving when Lidarr webhook auto-configuration fails", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("hookdown"));

        const req = {
            user: { id: "admin-1" },
            body: {
                lidarrEnabled: true,
                lidarrUrl: "http://lidarr:8686",
                lidarrApiKey: "lidarr-key",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(mockSystemSettingsUpsert).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("continues saving when webhook error includes response details", async () => {
        mockAxiosGet.mockRejectedValueOnce({
            message: "webhook down",
            response: { data: { error: "bad" } },
        } as any);

        const req = {
            user: { id: "admin-1" },
            body: {
                lidarrEnabled: true,
                lidarrUrl: "http://lidarr:8686",
                lidarrApiKey: "lidarr-key",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("does not disconnect Soulseek when the password merely round-trips as an empty string", async () => {
        const req = {
            user: { id: "admin-1" },
            body: {
                transcodeCacheMaxGb: 12,
                soulseekPassword: "",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockSoulseekService.disconnect).not.toHaveBeenCalled();
    });

    it("disconnects Soulseek on a real password change or explicit clear", async () => {
        const newPassReq = {
            user: { id: "admin-1" },
            body: { soulseekPassword: "brand-new-pass" },
        } as any;
        await postSettingsHandler(newPassReq, createRes());
        expect(mockSoulseekService.disconnect).toHaveBeenCalledTimes(1);

        const clearReq = {
            user: { id: "admin-1" },
            body: { soulseekPassword: null },
        } as any;
        await postSettingsHandler(clearReq, createRes());
        expect(mockSoulseekService.disconnect).toHaveBeenCalledTimes(2);
    });

    it("continues saving when Soulseek disconnect fails", async () => {
        mockSoulseekService.disconnect.mockImplementationOnce(() => {
            throw new Error("disconnect unavailable");
        });

        const req = {
            user: { id: "admin-1" },
            body: {
                audiobookshelfEnabled: true,
                transcodeCacheMaxGb: 12,
                soulseekUsername: "slsk-user",
                soulseekPassword: "slsk-pass",
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("continues saving when audiobooks cleanup fails", async () => {
        mockAudiobookProgressDeleteMany.mockRejectedValueOnce(
            new Error("cleanup unavailable"),
        );

        const req = {
            user: { id: "admin-1" },
            body: {
                audiobookshelfEnabled: false,
                transcodeCacheMaxGb: 12,
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("continues saving when environment sync is skipped by non-critical reason", async () => {
        mockWriteEnvFile.mockRejectedValueOnce(
            new Error("filesystem unavailable"),
        );

        const req = {
            user: { id: "admin-1" },
            body: {
                openaiEnabled: false,
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(mockWriteEnvFile).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("continues saving when Last.fm refresh key fails", async () => {
        mockLastFmService.refreshApiKey.mockRejectedValueOnce(
            new Error("api down"),
        );

        const req = {
            user: { id: "admin-1" },
            body: { maxConcurrentDownloads: 4 },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(mockLastFmService.refreshApiKey).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("returns 400 when settings payload fails validation", async () => {
        const req = {
            body: {
                soulseekConcurrentDownloads: 999,
            },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe("Invalid settings");
    });

    it("returns 400 for an invalid Lidarr URL", async () => {
        const req = { body: { lidarrUrl: "not a url" } } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(mockSystemSettingsUpsert).not.toHaveBeenCalled();
        expect(mockWriteEnvFile).not.toHaveBeenCalled();
    });

    it("returns 400 for a Lidarr URL containing a newline", async () => {
        const req = {
            body: { lidarrUrl: "http://lidarr:8686\nEVIL=1" },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(mockSystemSettingsUpsert).not.toHaveBeenCalled();
        expect(mockWriteEnvFile).not.toHaveBeenCalled();
    });

    it("preserves empty-string Lidarr URL clear semantics", async () => {
        const req = { body: { lidarrUrl: "" } } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockSystemSettingsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({ lidarrUrl: "" }),
            }),
        );
        expect(mockWriteEnvFile).toHaveBeenCalledWith(
            expect.objectContaining({ LIDARR_URL: null }),
        );
    });

    it("returns 400 for an invalid Audiobookshelf URL", async () => {
        const req = { body: { audiobookshelfUrl: "not a url" } } as any;
        const res = createRes();

        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(mockSystemSettingsUpsert).not.toHaveBeenCalled();
        expect(mockWriteEnvFile).not.toHaveBeenCalled();
    });

    it("continues successfully when env sync is skipped", async () => {
        mockWriteEnvFile.mockRejectedValue(
            new EnvFileSyncSkippedError("containerized env"),
        );

        const req = {
            user: { id: "admin-1" },
            body: { lidarrEnabled: false, transcodeCacheMaxGb: 12 },
        } as any;
        const res = createRes();

        await postSettingsHandler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("tests Lidarr endpoint success and connection-refused failure mapping", async () => {
        const okReq = {
            body: { url: "http://lidarr:8686/", apiKey: "key" },
        } as any;
        const okRes = createRes();
        await testLidarrHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body.success).toBe(true);

        mockAxiosGet.mockRejectedValueOnce({
            code: "ECONNREFUSED",
            message: "connect failed",
        });
        const failReq = {
            body: { url: "http://lidarr:8686", apiKey: "key" },
        } as any;
        const failRes = createRes();
        await testLidarrHandler(failReq, failRes);
        expect(failRes.statusCode).toBe(500);
        expect(failRes.body.details).toContain("Connection refused");
    });

    it("returns 400 for missing Lidarr credentials", async () => {
        const req = { body: { url: "", apiKey: "" } } as any;
        const res = createRes();
        await testLidarrHandler(req, res);
        expect(res.statusCode).toBe(400);
    });

    it("rejects unsafe Lidarr test URLs before attempting a request", async () => {
        const req = {
            body: { url: "http://127.0.0.1:8686", apiKey: "key" },
        } as any;
        const res = createRes();

        await testLidarrHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "URL must be a valid public HTTP(S) URL",
        });
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("accepts Docker/LAN service hostnames for the admin connection test", async () => {
        // Regression: the connection test must NOT DNS-resolve-and-reject
        // private ranges — in the documented compose deployment Lidarr lives on
        // the Docker bridge (http://lidarr:8686 resolves to 172.16/12), and an
        // admin probing their own integration is not an SSRF vector worth
        // breaking that for. Only the string check applies here.
        mockAxiosGet.mockResolvedValueOnce({
            status: 200,
            data: { version: "2.0.0" },
        });
        const req = {
            body: { url: "http://lidarr:8686", apiKey: "key" },
        } as any;
        const res = createRes();

        await testLidarrHandler(req, res);

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(res.statusCode).not.toBe(400);
    });

    it("returns friendly message when Lidarr host is unresolved", async () => {
        mockAxiosGet.mockRejectedValueOnce({
            code: "ENOTFOUND",
            message: "ENOTFOUND",
        });

        const req = {
            body: { url: "http://lidarr-missing", apiKey: "key" },
        } as any;
        const res = createRes();

        await testLidarrHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.details).toBe("Host not found - check the URL");
    });

    it("maps Lidarr unauthorized errors for test endpoint", async () => {
        mockAxiosGet.mockRejectedValueOnce({
            message: "auth failed",
            response: { status: 401 },
        } as any);

        const req = {
            body: { url: "http://lidarr:8686", apiKey: "bad-key" },
        } as any;
        const res = createRes();

        await testLidarrHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.details).toBe("Invalid API key");
    });

    it("returns Lidarr error message when no specific mapping exists", async () => {
        mockAxiosGet.mockRejectedValueOnce({
            response: {
                status: 500,
                data: { message: "service unavailable" },
            },
            message: "request failed",
        } as any);

        const req = {
            body: { url: "http://lidarr:8686", apiKey: "key" },
        } as any;
        const res = createRes();

        await testLidarrHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.details).toBe("Connection test failed");
    });

    it("validates Soulseek credentials and returns success/failure states", async () => {
        const missingReq = { body: { username: "", password: "" } } as any;
        const missingRes = createRes();
        await testSoulseekHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);

        const okReq = { body: { username: "u", password: "p" } } as any;
        const okRes = createRes();
        await testSoulseekHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body.success).toBe(true);
        expect(okRes.body.soulseekUsername).toBe("u");

        mockSlskClientConnect.mockImplementation(
            (
                _options: Record<string, unknown>,
                cb: (err: Error | null, client: unknown) => void,
            ) => {
                cb(new Error("invalid credentials"), null);
            },
        );
        const failReq = { body: { username: "u", password: "bad" } } as any;
        const failRes = createRes();
        await testSoulseekHandler(failReq, failRes);
        expect(failRes.statusCode).toBe(502);
        expect(failRes.statusCode).not.toBe(401);
        expect(failRes.body.error).toBe(
            "Invalid Soulseek credentials or connection failed",
        );
    });

    it("covers GET/POST auth middleware success and failure paths", async () => {
        const request = { user: { id: "user-1" } } as any;
        const unauthorizedRes = createRes();
        authFailureState.mode = "unauthorized";
        await runWithAuth(request, unauthorizedRes, async () => {
            await getSettingsHandler(request, unauthorizedRes);
        });
        expect(unauthorizedRes.statusCode).toBe(401);
        expect(unauthorizedRes.body).toEqual({ error: "Unauthorized" });
        expect(mockSystemSettingsFindUnique).not.toHaveBeenCalled();

        authFailureState.mode = "forbidden";
        const forbiddenRes = createRes();
        await runWithAuth(request, forbiddenRes, async () => {
            await postSettingsHandler(request, forbiddenRes);
        });
        expect(forbiddenRes.statusCode).toBe(403);
        expect(forbiddenRes.body).toEqual({ error: "Forbidden" });
        expect(mockSystemSettingsUpsert).not.toHaveBeenCalled();
    });

    it("returns 500 when getting settings fails", async () => {
        mockSystemSettingsFindUnique.mockRejectedValueOnce(
            new Error("database unavailable"),
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await getSettingsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get system settings" });
    });

    it("returns 500 when saving settings fails", async () => {
        mockSystemSettingsUpsert.mockRejectedValueOnce(
            new Error("write failed"),
        );

        const req = { user: { id: "admin-1" }, body: {} } as any;
        const res = createRes();
        await postSettingsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update system settings" });
    });

    it("returns 500 when cache clear fails", async () => {
        mockRedisClient.keys.mockRejectedValueOnce(
            new Error("redis unavailable"),
        );
        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await clearCachesHandler(req, res);
        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBe("Failed to clear caches");
    });

    it("tests OpenAI, Fanart, Last.fm, Audiobookshelf, and Spotify credentials", async () => {
        const openAiMissingReq = { body: {} } as any;
        const openAiMissingRes = createRes();
        await testOpenAiHandler(openAiMissingReq, openAiMissingRes);
        expect(openAiMissingRes.statusCode).toBe(400);

        const openAiReq = {
            body: { apiKey: "openai-key", model: "gpt-4o-mini" },
        } as any;
        const openAiRes = createRes();
        await testOpenAiHandler(openAiReq, openAiRes);
        expect(openAiRes.statusCode).toBe(200);
        expect(openAiRes.body.success).toBe(true);

        mockAxiosGet.mockRejectedValueOnce({ response: { status: 401 } });
        const fanartReq = { body: { fanartApiKey: "fanart-key" } } as any;
        const fanartRes = createRes();
        await testFanartHandler(fanartReq, fanartRes);
        expect(fanartRes.statusCode).toBe(502);
        expect(fanartRes.statusCode).not.toBe(401);
        expect(fanartRes.body).toEqual({
            error: "Invalid Fanart.tv API key",
        });

        mockAxiosGet.mockResolvedValueOnce({
            data: { artist: { name: "The Beatles" } },
        });
        const lastfmReq = { body: { lastfmApiKey: "lastfm-key" } } as any;
        const lastfmRes = createRes();
        await testLastfmHandler(lastfmReq, lastfmRes);
        expect(lastfmRes.statusCode).toBe(200);

        mockAxiosGet.mockResolvedValueOnce({ data: { libraries: [1, 2] } });
        const absReq = {
            body: { url: "http://audiobookshelf:13378", apiKey: "abs-key" },
        } as any;
        const absRes = createRes();
        await testAudiobookshelfHandler(absReq, absRes);
        expect(absRes.statusCode).toBe(200);
        expect(absRes.body.libraries).toBe(2);

        mockAxiosPost.mockResolvedValueOnce({
            data: { access_token: "spotify-token" },
        });
        const spotifyReq = {
            body: {
                clientId: "spotify-client",
                clientSecret: "spotify-secret",
            },
        } as any;
        const spotifyRes = createRes();
        await testSpotifyHandler(spotifyReq, spotifyRes);
        expect(spotifyRes.statusCode).toBe(200);
        expect(spotifyRes.body.success).toBe(true);
    });

    it("validates service test request payloads", async () => {
        const openAiReq = { body: {} } as any;
        const openAiRes = createRes();
        await testOpenAiHandler(openAiReq, openAiRes);
        expect(openAiRes.statusCode).toBe(400);

        const fanartReq = { body: {} } as any;
        const fanartRes = createRes();
        await testFanartHandler(fanartReq, fanartRes);
        expect(fanartRes.statusCode).toBe(400);

        const lastfmReq = { body: {} } as any;
        const lastfmRes = createRes();
        await testLastfmHandler(lastfmReq, lastfmRes);
        expect(lastfmRes.statusCode).toBe(400);

        const absReq = { body: {} } as any;
        const absRes = createRes();
        await testAudiobookshelfHandler(absReq, absRes);
        expect(absRes.statusCode).toBe(400);

        const spotifyReq = { body: {} } as any;
        const spotifyRes = createRes();
        await testSpotifyHandler(spotifyReq, spotifyRes);
        expect(spotifyRes.statusCode).toBe(400);

        const tidalReq = { body: {} } as any;
        const tidalRes = createRes();
        await tidalTokenHandler(tidalReq, tidalRes);
        expect(tidalRes.statusCode).toBe(400);
    });

    it("returns OpenAI API connection failures as 500 responses", async () => {
        mockAxiosPost.mockRejectedValueOnce({
            message: "openai-down",
            response: { data: { error: { message: "quota exceeded" } } },
        });

        const req = {
            body: { apiKey: "openai-key", model: "gpt-4o-mini" },
        } as any;
        const res = createRes();

        await testOpenAiHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to connect to OpenAI",
        });
    });

    it("maps Fanart, Last.fm, and Audiobookshelf generic failures to 500", async () => {
        mockAxiosGet.mockRejectedValueOnce({
            message: "fanart-down",
            response: { status: 500, data: "boom" },
        });
        const fanartReq = { body: { fanartApiKey: "fanart-key" } } as any;
        const fanartRes = createRes();
        await testFanartHandler(fanartReq, fanartRes);
        expect(fanartRes.statusCode).toBe(500);
        expect(fanartRes.body).toEqual({
            error: "Failed to connect to Fanart.tv",
        });

        mockAxiosGet.mockRejectedValueOnce({
            message: "lastfm-down",
            response: { status: 500, data: "boom" },
        });
        const lastfmReq = { body: { lastfmApiKey: "lastfm-key" } } as any;
        const lastfmRes = createRes();
        await testLastfmHandler(lastfmReq, lastfmRes);
        expect(lastfmRes.statusCode).toBe(500);
        expect(lastfmRes.body).toEqual({
            error: "Failed to connect to Last.fm",
        });

        mockAxiosGet.mockRejectedValueOnce({
            response: { status: 403, data: { error: 10 } },
            message: "bad key",
        } as any);
        const lastfmInvalidReq = { body: { lastfmApiKey: "bad-key" } } as any;
        const lastfmInvalidRes = createRes();
        await testLastfmHandler(lastfmInvalidReq, lastfmInvalidRes);
        expect(lastfmInvalidRes.statusCode).toBe(502);
        expect(lastfmInvalidRes.statusCode).not.toBe(401);
        expect(lastfmInvalidRes.body).toEqual({
            error: "Invalid Last.fm API key",
        });

        mockAxiosGet.mockRejectedValueOnce({
            message: "abs-down",
            response: { status: 500, data: "boom" },
        });
        const absReq = {
            body: { url: "http://audiobookshelf:13378", apiKey: "abs-key" },
        } as any;
        const absRes = createRes();
        await testAudiobookshelfHandler(absReq, absRes);
        expect(absRes.statusCode).toBe(500);
        expect(absRes.body).toEqual({
            error: "Failed to connect to Audiobookshelf",
        });

        mockAxiosGet.mockRejectedValueOnce({
            response: { status: 401 },
            message: "bad key",
        } as any);
        const absInvalidReq = {
            body: { url: "http://audiobookshelf:13378", apiKey: "bad-key" },
        } as any;
        const absInvalidRes = createRes();
        await testAudiobookshelfHandler(absInvalidReq, absInvalidRes);
        expect(absInvalidRes.statusCode).toBe(502);
        expect(absInvalidRes.statusCode).not.toBe(401);
        expect(absInvalidRes.body).toEqual({
            error: "Invalid Audiobookshelf API key",
        });
    });

    it("rejects unsafe Audiobookshelf test URLs before attempting a request", async () => {
        const req = {
            body: { url: "http://library.internal:13378", apiKey: "abs-key" },
        } as any;
        const res = createRes();

        await testAudiobookshelfHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "URL must be a valid public HTTP(S) URL",
        });
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("covers fanart success path and Last.fm unexpected payload failures", async () => {
        mockAxiosGet.mockResolvedValueOnce({ data: { poster: "ok" } });
        const fanartReq = { body: { fanartApiKey: "fanart-key" } } as any;
        const fanartRes = createRes();
        await testFanartHandler(fanartReq, fanartRes);
        expect(fanartRes.statusCode).toBe(200);
        expect(fanartRes.body.success).toBe(true);

        mockAxiosGet.mockResolvedValueOnce({ data: {} });
        const lastfmReq = { body: { lastfmApiKey: "lastfm-key" } } as any;
        const lastfmRes = createRes();
        await testLastfmHandler(lastfmReq, lastfmRes);
        expect(lastfmRes.statusCode).toBe(500);
        expect(lastfmRes.body.error).toBe("Unexpected response from Last.fm");
    });

    it("returns 502 for invalid Spotify credentials", async () => {
        mockAxiosPost.mockRejectedValueOnce({
            response: { data: { error_description: "invalid_client" } },
        });

        const req = { body: { clientId: "bad", clientSecret: "bad" } } as any;
        const res = createRes();
        await testSpotifyHandler(req, res);
        expect(res.statusCode).toBe(502);
        expect(res.statusCode).not.toBe(401);
        expect(res.body).toEqual({
            error: "Invalid Spotify credentials",
        });
    });

    it("tests TIDAL connection and device auth/token flow", async () => {
        mockTidalService.isSidecarHealthy.mockResolvedValueOnce(false);
        const downReq = { body: {} } as any;
        const downRes = createRes();
        await testTidalHandler(downReq, downRes);
        expect(downRes.statusCode).toBe(503);
        expect(downRes.body).toEqual({
            error: "TIDAL service is not running",
            details:
                "The tidal-streamer container is not reachable. Make sure it is running.",
        });

        mockTidalService.isSidecarHealthy.mockResolvedValueOnce(true);
        mockTidalService.verifySession.mockResolvedValueOnce({ valid: false });
        const unauthReq = { body: {} } as any;
        const unauthRes = createRes();
        await testTidalHandler(unauthReq, unauthRes);
        expect(unauthRes.statusCode).toBe(502);
        expect(unauthRes.statusCode).not.toBe(401);
        expect(unauthRes.body).toEqual({
            error: "Not authenticated to TIDAL",
            details:
                "Use the TIDAL settings panel to authenticate via device authorization.",
        });

        mockTidalService.isSidecarHealthy.mockResolvedValueOnce(true);
        const okReq = { body: {} } as any;
        const okRes = createRes();
        await testTidalHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body.success).toBe(true);

        mockTidalService.isSidecarHealthy.mockResolvedValueOnce(false);
        const deviceDownReq = { body: {} } as any;
        const deviceDownRes = createRes();
        await tidalDeviceHandler(deviceDownReq, deviceDownRes);
        expect(deviceDownRes.statusCode).toBe(503);

        mockTidalService.isSidecarHealthy.mockResolvedValueOnce(true);
        const deviceReq = { body: {} } as any;
        const deviceRes = createRes();
        await tidalDeviceHandler(deviceReq, deviceRes);
        expect(deviceRes.statusCode).toBe(200);
        expect(deviceRes.body.deviceCode).toBe("device-code");

        const tokenMissingReq = { body: {} } as any;
        const tokenMissingRes = createRes();
        await tidalTokenHandler(tokenMissingReq, tokenMissingRes);
        expect(tokenMissingRes.statusCode).toBe(400);

        mockTidalService.pollDeviceAuth.mockResolvedValueOnce(null);
        const tokenPendingReq = { body: { device_code: "pending" } } as any;
        const tokenPendingRes = createRes();
        await tidalTokenHandler(tokenPendingReq, tokenPendingRes);
        expect(tokenPendingRes.statusCode).toBe(202);
        expect(tokenPendingRes.body.status).toBe("pending");

        const tokenReq = { body: { device_code: "device-code" } } as any;
        const tokenRes = createRes();
        await tidalTokenHandler(tokenReq, tokenRes);
        expect(tokenRes.statusCode).toBe(200);
        expect(mockTidalService.saveTokens).toHaveBeenCalled();
    });

    it("handles TIDAL sidecar errors as failures", async () => {
        mockTidalService.isSidecarHealthy.mockRejectedValueOnce(
            new Error("sidecar panic"),
        );
        const downReq = { body: {} } as any;
        const downRes = createRes();
        await testTidalHandler(downReq, downRes);
        expect(downRes.statusCode).toBe(500);
        expect(downRes.body.error).toBe("Failed to test TIDAL connection");

        mockTidalService.isSidecarHealthy.mockRejectedValueOnce(
            new Error("device sidecar panic"),
        );
        const deviceRes = createRes();
        await tidalDeviceHandler({}, deviceRes);
        expect(deviceRes.statusCode).toBe(500);
        expect(deviceRes.body.error).toBe("Failed to initiate TIDAL auth");

        mockTidalService.pollDeviceAuth.mockRejectedValueOnce(
            new Error("token panic"),
        );
        const tokenReq = { body: { device_code: "device-code" } } as any;
        const tokenRes = createRes();
        await tidalTokenHandler(tokenReq, tokenRes);
        expect(tokenRes.statusCode).toBe(500);
        expect(tokenRes.body.error).toBe("Failed to complete TIDAL auth");
    });

    it("handles Soulseek dynamic import failures in test endpoint", async () => {
        throwSoulseekImport = true;

        const req = { body: { username: "u", password: "p" } } as any;
        const res = createRes();

        await testSoulseekHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to test Soulseek connection",
        });
    });

    it("maps a Spotify token request failure to invalid credentials", async () => {
        mockAxiosPost.mockRejectedValueOnce({
            message: "rate limited",
            response: { data: {} },
        } as any);

        const req = {
            body: { clientId: "client-id", clientSecret: "client-secret" },
        } as any;
        const res = createRes();

        await testSpotifyHandler(req, res);

        expect(res.statusCode).toBe(502);
        expect(res.statusCode).not.toBe(401);
        expect(res.body).toEqual({
            error: "Invalid Spotify credentials",
        });
    });

    it("maps a Spotify token response without an access token to invalid credentials", async () => {
        mockAxiosPost.mockResolvedValueOnce({ data: {} });

        const req = {
            body: { clientId: "client-id", clientSecret: "client-secret" },
        } as any;
        const res = createRes();

        await testSpotifyHandler(req, res);

        expect(res.statusCode).toBe(502);
        expect(res.statusCode).not.toBe(401);
        expect(res.body).toEqual({
            error: "Invalid Spotify credentials",
        });
    });

    it("maps Spotify unexpected runtime errors to 500", async () => {
        const req = {} as any;
        Object.defineProperty(req, "body", {
            get() {
                throw new Error("spotify runtime failure");
            },
        });

        const res = createRes();
        await testSpotifyHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to test Spotify credentials",
        });
    });

    it("manages the cluster queue-cleaner job and clears cache keys while preserving sessions", async () => {
        mockSchedulerQueueGetJob.mockResolvedValueOnce(mockSchedulerJob);
        mockSchedulerJobGetState.mockResolvedValueOnce("active");
        const queueStatusReq = { user: { id: "user-1" } } as any;
        const queueStatusRes = createRes();
        await queueStatusHandler(queueStatusReq, queueStatusRes);
        expect(queueStatusRes.statusCode).toBe(200);
        expect(queueStatusRes.body).toEqual({
            running: true,
            queued: false,
            state: "active",
            jobId: "scheduler:reconciliation:on-demand",
            workerOwned: true,
        });

        const startReq = { user: { id: "user-1" } } as any;
        const startRes = createRes();
        await queueStartHandler(startReq, startRes);
        expect(startRes.statusCode).toBe(200);
        expect(mockSchedulerQueueAdd).toHaveBeenCalledWith(
            "download-reconciliation-cycle",
            {
                mode: "repeat",
                source: "system-settings",
            },
            {
                jobId: "scheduler:reconciliation:on-demand",
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(startRes.body).toEqual({
            success: true,
            message: "Queue cleaner job enqueued",
            status: {
                running: false,
                queued: true,
                state: "waiting",
                jobId: "scheduler:reconciliation:on-demand",
                workerOwned: true,
            },
        });

        mockSchedulerQueueGetJob.mockResolvedValueOnce(mockSchedulerJob);
        mockSchedulerJobGetState.mockResolvedValueOnce("waiting");
        const stopReq = { user: { id: "user-1" } } as any;
        const stopRes = createRes();
        await queueStopHandler(stopReq, stopRes);
        expect(stopRes.statusCode).toBe(200);
        expect(mockSchedulerJobRemove).toHaveBeenCalledTimes(1);
        expect(stopRes.body).toEqual({
            success: true,
            message: "Queued queue cleaner job cancelled",
            status: {
                running: false,
                queued: false,
                state: "idle",
                jobId: null,
                workerOwned: true,
            },
        });

        mockRedisClient.keys.mockResolvedValue([
            "sess:abc",
            "search:cache:1",
            "discover:cache:2",
        ] as any);
        const clearReq = { user: { id: "user-1" } } as any;
        const clearRes = createRes();
        await clearCachesHandler(clearReq, clearRes);
        expect(clearRes.statusCode).toBe(200);
        expect(clearRes.body.clearedKeys).toBe(2);
        expect(mockRedisClient.del).toHaveBeenCalledTimes(2);
        expect(mockNotificationService.notifySystem).toHaveBeenCalledWith(
            "user-1",
            "Caches Cleared",
            "Successfully cleared 2 cache entries",
        );
    });

    it("sanitizes queue cleaner enqueue failures while logging raw detail", async () => {
        const queueError = new Error("redis://secret@queue unavailable");
        mockSchedulerQueueAdd.mockRejectedValueOnce(queueError);
        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await queueStartHandler(req, res);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to start queue cleaner" });
        expect(JSON.stringify(res.body)).not.toContain("redis://secret");
        expect(mockQueueCleanerLogError).toHaveBeenCalledWith(
            "Failed to enqueue queue cleaner worker job",
            queueError,
        );
    });

    it("refuses to interrupt an active claimed queue cleaner job", async () => {
        mockSchedulerQueueGetJob.mockResolvedValueOnce(mockSchedulerJob);
        mockSchedulerJobGetState.mockResolvedValueOnce("active");
        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await queueStopHandler(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({
            error: "Queue cleaner job is already active",
        });
        expect(mockSchedulerJobRemove).not.toHaveBeenCalled();
    });

    it("sanitizes queue cleaner status and cancellation failures", async () => {
        const statusError = new Error("redis://status-secret@queue");
        mockSchedulerQueueGetJob.mockRejectedValueOnce(statusError);
        const statusRes = createRes();

        await queueStatusHandler({ user: { id: "user-1" } } as any, statusRes);

        expect(statusRes.statusCode).toBe(500);
        expect(statusRes.body).toEqual({
            error: "Failed to get queue cleaner status",
        });
        expect(JSON.stringify(statusRes.body)).not.toContain("status-secret");
        expect(mockQueueCleanerLogError).toHaveBeenCalledWith(
            "Failed to read queue cleaner worker status",
            statusError,
        );

        const cancellationError = new Error("redis://stop-secret@queue");
        mockSchedulerQueueGetJob.mockResolvedValueOnce(mockSchedulerJob);
        mockSchedulerJobGetState.mockResolvedValueOnce("waiting");
        mockSchedulerJobRemove.mockRejectedValueOnce(cancellationError);
        const stopRes = createRes();

        await queueStopHandler({ user: { id: "user-1" } } as any, stopRes);

        expect(stopRes.statusCode).toBe(500);
        expect(stopRes.body).toEqual({ error: "Failed to stop queue cleaner" });
        expect(JSON.stringify(stopRes.body)).not.toContain("stop-secret");
        expect(mockQueueCleanerLogError).toHaveBeenCalledWith(
            "Failed to cancel queued queue cleaner worker job",
            cancellationError,
        );
    });

    it("handles cache clear when no non-session keys exist", async () => {
        mockRedisClient.keys.mockResolvedValue(["sess:a", "sess:b"] as any);
        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await clearCachesHandler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.clearedKeys).toBe(0);
        expect(mockRedisClient.del).not.toHaveBeenCalled();
    });
});
