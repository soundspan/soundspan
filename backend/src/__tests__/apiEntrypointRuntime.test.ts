describe("api entrypoint runtime behavior", () => {
    const originalEnv = process.env;
    const originalExit = process.exit;

    const routeModules = [
        "../routes/auth",
        "../routes/onboarding",
        "../routes/library",
        "../routes/plays",
        "../routes/settings",
        "../routes/social",
        "../routes/systemSettings",
        "../routes/listeningState",
        "../routes/playbackState",
        "../routes/offline",
        "../routes/playlists",
        "../routes/search",
        "../routes/recommendations",
        "../routes/downloads",
        "../routes/webhooks",
        "../routes/audiobooks",
        "../routes/podcasts",
        "../routes/artists",
        "../routes/soulseek",
        "../routes/discover",
        "../routes/apiKeys",
        "../routes/mixes",
        "../routes/enrichment",
        "../routes/homepage",
        "../routes/deviceLink",
        "../routes/notifications",
        "../routes/browse",
        "../routes/analysis",
        "../routes/releases",
        "../routes/vibe",
        "../routes/system",
        "../routes/youtubeMusic",
        "../routes/tidalStreaming",
        "../routes/trackMappings",
        "../routes/playlistImport",
        "../routes/lyrics",
        "../routes/listenTogether",
        "../routes/subsonic",
        "../routes/shareLinks",
        "../routes/federation",
        "../routes/federationAdmin",
        "../routes/libraryHealthDashboard",
    ];

    const flushPromises = async (): Promise<void> => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    function setupApiEntrypointMocks({
        dependencyProbeImpl,
        dependencyHealthy = true,
        invokeListenCallback = true,
        redisCloseImpl,
        prismaDisconnectImpl,
        prismaConnectImpl,
        prismaQueryRawImpl,
        prismaFindFirstImpl,
        shutdownWorkersImpl,
        configOverrides,
        bcryptHashImpl,
    }: {
        dependencyProbeImpl?: () => Promise<any>;
        dependencyHealthy?: boolean;
        invokeListenCallback?: boolean;
        redisCloseImpl?: () => Promise<unknown>;
        prismaDisconnectImpl?: () => Promise<unknown>;
        prismaConnectImpl?: () => Promise<unknown>;
        prismaQueryRawImpl?: () => Promise<unknown>;
        prismaFindFirstImpl?: () => Promise<unknown>;
        shutdownWorkersImpl?: () => Promise<unknown>;
        configOverrides?: {
            nodeEnv?: string;
            allowedOrigins?: string[] | boolean;
            sessionSecret?: string;
            port?: number;
            socketKeepAliveDelayMs?: number;
            databaseUrl?: string;
            redisUrl?: string;
            docsPublic?: boolean;
            adminResetPassword?: string;
            discover?: {
                mode: "legacy" | "recommendation";
            };
            features?: {
                audioAnalysis?: boolean;
                discovery?: boolean;
                autoPlaylists?: boolean;
                federation?: boolean;
            };
        };
        bcryptHashImpl?: (value: string, salt: number) => Promise<string>;
    } = {}) {
        const app = {
            use: jest.fn(),
            get: jest.fn(),
            set: jest.fn(),
        };
        const router = {
            use: jest.fn(),
            get: jest.fn(),
            post: jest.fn(),
            put: jest.fn(),
            patch: jest.fn(),
            delete: jest.fn(),
        };
        const expressFn = jest.fn(() => app);
        (expressFn as any).json = jest.fn(() => "json-middleware");
        (expressFn as any).urlencoded = jest.fn(() => "urlencoded-middleware");
        (expressFn as any).Router = jest.fn(() => router);

        const sessionMiddleware = jest.fn(() => "session-middleware");
        const redisStoreCtor = jest.fn(() => ({}));
        const corsMiddleware = jest.fn(() => "cors-middleware");
        const helmetMiddleware = jest.fn(() => "helmet-middleware");
        const compressionFilter = jest.fn(() => true);
        const compressionMiddleware = Object.assign(
            jest.fn(() => "compression-middleware"),
            { filter: compressionFilter },
        );

        const redisClient = {
            isReady: true,
            ping: jest.fn(async () => "PONG"),
            close: jest.fn(redisCloseImpl || (async () => "OK")),
        };
        const prisma = {
            $queryRaw: jest.fn(prismaQueryRawImpl || (async () => 1)),
            $disconnect: jest.fn(
                prismaDisconnectImpl || (async () => undefined),
            ),
            $connect: jest.fn(prismaConnectImpl || (async () => undefined)),
            user: {
                findFirst: jest.fn(prismaFindFirstImpl || (async () => null)),
                update: jest.fn(async () => undefined),
            },
        };
        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn().mockReturnThis(),
        };

        const dependencyReadiness = {
            probe: jest.fn(
                dependencyProbeImpl ||
                    (async () => ({
                        required: true,
                        overallHealthy: dependencyHealthy,
                        postgres: { ok: dependencyHealthy },
                        redis: { ok: dependencyHealthy },
                    })),
            ),
            isHealthy: jest.fn(() => dependencyHealthy),
            getSnapshot: jest.fn(() => ({
                required: true,
                overallHealthy: dependencyHealthy,
                postgres: { ok: dependencyHealthy },
                redis: { ok: dependencyHealthy },
            })),
        };
        const createDependencyReadinessTracker = jest.fn(
            () => dependencyReadiness,
        );

        const setupListenTogetherSocket = jest.fn();
        const shutdownListenTogetherSocket = jest.fn();
        const startPersistLoop = jest.fn();
        const stopPersistLoop = jest.fn();
        const persistAllGroups = jest.fn(async () => undefined);
        const ensureFederationIdentity = jest.fn(async () => ({
            federationInstanceId: "instance-1",
            catalogEpoch: "epoch-1",
        }));

        const serverEventHandlers = new Map<string, (...args: any[]) => void>();
        const server: any = {
            keepAliveTimeout: 5_000,
            headersTimeout: 60_000,
            timeout: 0,
        };
        server.listen = jest.fn((_port, _host, cb?: () => void) => {
            if (invokeListenCallback) {
                void Promise.resolve(cb?.());
            }
        });
        server.close = jest.fn((cb?: () => void) => {
            cb?.();
        });
        server.on = jest.fn(
            (event: string, handler: (...args: any[]) => void) => {
                serverEventHandlers.set(event, handler);
                return server;
            },
        );
        server.closeIdleConnections = jest.fn();
        server.closeAllConnections = jest.fn();
        const createServer = jest.fn(() => server);

        const requireAuth = jest.fn((_req, _res, next) => next?.());
        const requireAdmin = jest.fn((_req, _res, next) => next?.());
        const errorHandler = jest.fn((_err, _req, _res, _next) => undefined);
        const authLimiter = "auth-limiter";
        const apiLimiter = "api-limiter";
        const adminSurfaceLimiter = "admin-surface-limiter";
        const shareLinkLimiter = "share-link-limiter";
        const imageLimiter = "image-limiter";
        const lyricsLimiter = "lyrics-limiter";
        const swaggerSetup = jest.fn(() => "swagger-setup-middleware");
        const swaggerServe = "swagger-serve-middleware";
        const config = {
            nodeEnv: "test",
            allowedOrigins: true,
            sessionSecret: "test-secret",
            port: 3006,
            socketKeepAliveDelayMs: 30_000,
            databaseUrl: "postgresql://user:secret@db:5432/soundspan",
            redisUrl: "redis://redis:6379/0",
            docsPublic: false,
            metrics: { token: "metrics-token", publicAccess: false },
            streaming: { traceEnabled: false },
            adminResetPassword: undefined,
            discover: { mode: "recommendation" },
            ...(configOverrides || {}),
            features: {
                audioAnalysis: true,
                discovery: true,
                autoPlaylists: true,
                federation: true,
                ...(configOverrides?.features || {}),
            },
        };
        const hashedAdminPassword =
            bcryptHashImpl || (async () => "hashed-admin-password");

        const createBullBoard = jest.fn();
        const BullAdapter = jest.fn((queue) => ({ queue }));
        const ExpressAdapter = jest.fn(() => ({
            setBasePath: jest.fn(),
            getRouter: jest.fn(() => "bull-router"),
        }));

        const workersQueues = {
            scanQueue: { name: "scan" },
            discoverQueue: { name: "discover" },
            imageQueue: { name: "image" },
        };
        const queueRegistry = Object.values(workersQueues);
        const registerQueueMetrics = jest.fn();
        const metricsRouter = "metrics-router";
        const createMetricsRouter = jest.fn(() => metricsRouter);
        const metricsRegistry = { contentType: "text/plain" };
        const httpMetricsMiddleware = "http-metrics-middleware";
        const shutdownWorkers = jest.fn(
            shutdownWorkersImpl || (async () => undefined),
        );
        const shutdownUmapProjection = jest.fn(async () => undefined);

        jest.doMock("express", () => expressFn);
        jest.doMock("express-session", () => sessionMiddleware, {
            virtual: true,
        });
        jest.doMock("connect-redis", () => ({ RedisStore: redisStoreCtor }), {
            virtual: true,
        });
        jest.doMock("cors", () => corsMiddleware);
        jest.doMock("helmet", () => helmetMiddleware);
        jest.doMock("compression", () => compressionMiddleware);
        jest.doMock("http", () => ({ createServer }));
        jest.doMock("../config", () => ({
            config,
            initializeMusicConfig: jest.fn(async () => undefined),
        }));
        jest.doMock("../utils/redis", () => ({ redisClient }));
        jest.doMock("../utils/db", () => ({ prisma }));
        jest.doMock("../utils/logger", () => ({ logger }));
        jest.doMock("../utils/dependencyReadiness", () => ({
            createDependencyReadinessTracker,
        }));
        jest.doMock("../services/listenTogetherSocket", () => ({
            setupListenTogetherSocket,
            shutdownListenTogetherSocket,
        }));
        jest.doMock("../services/listenTogether", () => ({
            startPersistLoop,
            stopPersistLoop,
            persistAllGroups,
        }));
        jest.doMock("../services/federationPeers", () => ({
            ensureFederationIdentity,
        }));
        jest.doMock("../middleware/errorHandler", () => ({ errorHandler }));
        jest.doMock("../middleware/auth", () => ({
            requireAuth,
            requireAdmin,
        }));
        jest.doMock("../middleware/rateLimiter", () => ({
            authLimiter,
            apiLimiter,
            adminSurfaceLimiter,
            shareLinkLimiter,
            imageLimiter,
            lyricsLimiter,
        }));
        jest.doMock("swagger-ui-express", () => ({
            serve: swaggerServe,
            setup: swaggerSetup,
        }));
        jest.doMock("../config/swagger", () => ({
            swaggerSpec: { openapi: "3.0.0" },
        }));
        jest.doMock("bcrypt", () => ({
            hash: hashedAdminPassword,
        }));
        jest.doMock("@bull-board/api", () => ({ createBullBoard }));
        jest.doMock("@bull-board/api/bullAdapter", () => ({ BullAdapter }));
        jest.doMock("@bull-board/express", () => ({ ExpressAdapter }));
        jest.doMock("../workers/queues", () => ({
            ...workersQueues,
            queues: queueRegistry,
        }));
        jest.doMock("../metrics", () => ({
            httpMetricsMiddleware,
            metricsRegistry,
        }));
        jest.doMock("../metrics/endpoint", () => ({ createMetricsRouter }));
        jest.doMock("../metrics/queueMetrics", () => ({
            registerQueueMetrics,
        }));
        jest.doMock("../workers", () => ({
            shutdownWorkers,
        }));
        jest.doMock("../services/umapProjection", () => ({
            shutdownUmapProjection,
        }));

        for (const routeModule of routeModules) {
            jest.doMock(routeModule, () => ({
                __esModule: true,
                default: { use: jest.fn() },
            }));
        }

        return {
            app,
            createServer,
            server,
            serverEventHandlers,
            redisClient,
            prisma,
            logger,
            createDependencyReadinessTracker,
            dependencyReadiness,
            setupListenTogetherSocket,
            shutdownListenTogetherSocket,
            startPersistLoop,
            stopPersistLoop,
            persistAllGroups,
            ensureFederationIdentity,
            createBullBoard,
            BullAdapter,
            ExpressAdapter,
            requireAuth,
            requireAdmin,
            shutdownWorkers,
            shutdownUmapProjection,
            compressionMiddleware,
            compressionFilter,
            createMetricsRouter,
            registerQueueMetrics,
            metricsRegistry,
            metricsRouter,
            httpMetricsMiddleware,
            sessionMiddleware,
            redisStoreCtor,
        };
    }

    function createJsonRes() {
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

    function getGetHandler(
        app: { get: jest.Mock },
        routePath: string,
    ): (req: any, res: any) => unknown {
        const call = app.get.mock.calls.find(
            (args: unknown[]) => args[0] === routePath,
        );
        if (!call) {
            throw new Error(`GET route not registered: ${routePath}`);
        }

        const handlers = call.slice(1);
        return handlers[handlers.length - 1] as any;
    }

    function getProcessHandler(
        processOnSpy: jest.SpyInstance,
        event: string,
    ): (...args: any[]) => any {
        const call = processOnSpy.mock.calls.find(
            (args: [string | symbol]) => args[0] === event,
        );
        if (!call) {
            throw new Error(`Process handler not registered: ${event}`);
        }
        return call[1] as (...args: any[]) => any;
    }

    beforeEach(() => {
        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
    });

    afterEach(() => {
        process.env = originalEnv;
        process.exit = originalExit;
        jest.restoreAllMocks();
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("boots API runtime and wires listen-together + health dependencies", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockImplementation(() => 1 as unknown as NodeJS.Timeout);
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.createServer).toHaveBeenCalledTimes(1);
        expect(mocks.compressionMiddleware).toHaveBeenCalledWith(
            expect.objectContaining({
                threshold: 1024,
                filter: expect.any(Function),
            }),
        );
        expect(mocks.app.use).toHaveBeenCalledWith("compression-middleware");
        expect(mocks.app.use).toHaveBeenCalledWith(mocks.httpMetricsMiddleware);
        expect(mocks.app.use).toHaveBeenCalledWith(mocks.metricsRouter);
        expect(mocks.createMetricsRouter).toHaveBeenCalledWith({
            registry: mocks.metricsRegistry,
            token: "metrics-token",
            publicAccess: false,
        });
        expect(mocks.registerQueueMetrics).toHaveBeenCalled();
        expect(mocks.server.listen).toHaveBeenCalledWith(
            3006,
            "0.0.0.0",
            expect.any(Function),
        );
        expect(mocks.prisma.$queryRaw).toHaveBeenCalled();
        expect(mocks.redisClient.ping).toHaveBeenCalled();
        expect(mocks.createDependencyReadinessTracker).toHaveBeenCalledWith(
            "api",
        );
        expect(mocks.setupListenTogetherSocket).toHaveBeenCalledWith(
            mocks.server,
        );
        expect(
            mocks.logger.warn.mock.calls.filter(([message]) =>
                String(message).includes("deprecated"),
            ),
        ).toHaveLength(0);
        expect(mocks.server.on).toHaveBeenCalledWith(
            "connection",
            expect.any(Function),
        );
        expect(mocks.server.keepAliveTimeout).toBe(65_000);
        expect(mocks.server.headersTimeout).toBe(70_000);
        expect(mocks.server.timeout).toBe(0);

        const socket = {
            setKeepAlive: jest.fn(),
            on: jest.fn(),
        };
        mocks.serverEventHandlers.get("connection")?.(socket);
        expect(socket.setKeepAlive).toHaveBeenCalledWith(true, 30_000);
        expect(mocks.startPersistLoop).toHaveBeenCalledTimes(1);
        expect(mocks.createBullBoard).toHaveBeenCalledTimes(1);
        expect(mocks.app.get).toHaveBeenCalledWith(
            "/api/docs.json",
            expect.any(Function),
        );
        expect(processOnSpy).toHaveBeenCalled();
        expect(setIntervalSpy).toHaveBeenCalled();
    });

    it("warns once when the API starts in legacy discovery mode", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks({
            configOverrides: { discover: { mode: "legacy" } },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const deprecatedWarnings = mocks.logger.warn.mock.calls.filter(
            ([message]) => String(message).includes("deprecated"),
        );
        expect(deprecatedWarnings).toHaveLength(1);
        expect(String(deprecatedWarnings[0][0])).toContain(
            "migrate by unsetting DISCOVERY_MODE",
        );
    });

    it("does not mount cookie-session middleware", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        jest.spyOn(process, "on").mockImplementation(() => process as any);
        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.sessionMiddleware).not.toHaveBeenCalled();
        expect(mocks.redisStoreCtor).not.toHaveBeenCalled();
        expect(mocks.app.use).not.toHaveBeenCalledWith("session-middleware");
    });

    it("mounts FEATURE_DISABLED 404 handlers for gated prefixes when flags are off", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        jest.spyOn(process, "on").mockImplementation(() => process as any);
        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks({
            configOverrides: {
                features: {
                    audioAnalysis: false,
                    discovery: false,
                    autoPlaylists: false,
                    federation: false,
                },
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        for (const prefix of [
            "/api/discover",
            "/api/recommendations",
            "/api/mixes",
            "/api/analysis",
            "/api/vibe",
            "/api/federation/v1",
            "/api/federation/admin",
        ]) {
            const call = mocks.app.use.mock.calls.find(
                (args: unknown[]) => args[0] === prefix,
            );
            expect(call).toBeDefined();
            // Disabled prefixes stay rate limited and mount the
            // feature-disabled handler instead of the router module.
            expect(call![1]).toBe(
                prefix === "/api/federation/admin"
                    ? "admin-surface-limiter"
                    : "api-limiter",
            );
            expect(call).toHaveLength(3);

            const handler = call![call!.length - 1] as (
                req: any,
                res: any,
            ) => void;
            expect(typeof handler).toBe("function");

            const res = createJsonRes();
            handler({}, res);
            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({
                error: "feature disabled",
                code: "FEATURE_DISABLED",
            });
        }
        expect(mocks.ensureFederationIdentity).not.toHaveBeenCalled();
    });

    it("mounts gated routers normally when feature flags are on", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        jest.spyOn(process, "on").mockImplementation(() => process as any);
        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        for (const prefix of [
            "/api/discover",
            "/api/recommendations",
            "/api/mixes",
            "/api/analysis",
            "/api/vibe",
        ]) {
            const call = mocks.app.use.mock.calls.find(
                (args: unknown[]) => args[0] === prefix,
            );
            expect(call).toBeDefined();
            expect(call![1]).toBe("api-limiter");
            expect(call).toHaveLength(3);
        }
        expect(mocks.ensureFederationIdentity).toHaveBeenCalledTimes(1);
    });

    it("mounts every API prefix behind its expected limiter and router (mount contract)", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        jest.spyOn(process, "on").mockImplementation(() => process as any);
        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const route = (id: string) => require(id).default;

        // The full mount contract: prefix -> exact middleware chain in order.
        // Removing a limiter, swapping tiers, or mounting a router without
        // its expected limiter fails this test. Router-level auth for the
        // routers themselves is asserted by their per-router authz tests.
        const expectedMounts: Record<string, unknown[]> = {
            "/api/auth/login": ["auth-limiter"],
            "/api/auth/register": ["auth-limiter"],
            "/api/auth": [route("../routes/auth")],
            "/api/onboarding/register": ["auth-limiter"],
            "/api/onboarding": ["api-limiter", route("../routes/onboarding")],
            "/api/api-keys": ["api-limiter", route("../routes/apiKeys")],
            "/api/device-link": ["auth-limiter", route("../routes/deviceLink")],
            "/api/library": [route("../routes/library")],
            "/api/plays": ["api-limiter", route("../routes/plays")],
            "/api/settings": ["api-limiter", route("../routes/settings")],
            "/api/social": ["api-limiter", route("../routes/social")],
            "/api/system-settings": [
                "admin-surface-limiter",
                route("../routes/systemSettings"),
            ],
            "/api/listening-state": [
                "api-limiter",
                route("../routes/listeningState"),
            ],
            "/api/playback-state": [route("../routes/playbackState")],
            "/api/offline": ["api-limiter", route("../routes/offline")],
            "/api/playlists": ["api-limiter", route("../routes/playlists")],
            "/api/share-links": [
                "share-link-limiter",
                route("../routes/shareLinks"),
            ],
            "/api/search": ["api-limiter", route("../routes/search")],
            "/api/recommendations": [
                "api-limiter",
                route("../routes/recommendations"),
            ],
            "/api/downloads": ["api-limiter", route("../routes/downloads")],
            "/api/notifications": [
                "api-limiter",
                route("../routes/notifications"),
            ],
            "/api/webhooks": [route("../routes/webhooks")],
            "/api/audiobooks": [route("../routes/audiobooks")],
            "/api/podcasts": ["api-limiter", route("../routes/podcasts")],
            "/api/artists": ["api-limiter", route("../routes/artists")],
            "/api/soulseek": ["api-limiter", route("../routes/soulseek")],
            "/api/discover": ["api-limiter", route("../routes/discover")],
            "/api/mixes": ["api-limiter", route("../routes/mixes")],
            "/api/enrichment": ["api-limiter", route("../routes/enrichment")],
            "/api/homepage": ["api-limiter", route("../routes/homepage")],
            "/api/browse": ["api-limiter", route("../routes/browse")],
            "/api/analysis": ["api-limiter", route("../routes/analysis")],
            "/api/admin": ["admin-surface-limiter", route("../routes/admin")],
            "/api/library-health": [
                "admin-surface-limiter",
                route("../routes/libraryHealthDashboard"),
            ],
            "/api/releases": ["api-limiter", route("../routes/releases")],
            "/api/vibe": ["api-limiter", route("../routes/vibe")],
            "/api/system": ["api-limiter", route("../routes/system")],
            "/api/ytmusic": ["api-limiter", route("../routes/youtubeMusic")],
            "/api/youtube": ["api-limiter", route("../routes/youtube")],
            "/api/tidal-streaming": [
                "api-limiter",
                route("../routes/tidalStreaming"),
            ],
            "/api/track-mappings": [
                "api-limiter",
                route("../routes/trackMappings"),
            ],
            "/api/import": ["api-limiter", route("../routes/playlistImport")],
            "/api/streaming": ["api-limiter", route("../routes/streaming")],
            "/api/lyrics": ["lyrics-limiter", route("../routes/lyrics")],
            "/api/listen-together": [
                "api-limiter",
                route("../routes/listenTogether"),
            ],
            "/api/federation/v1": [
                "api-limiter",
                route("../routes/federation"),
            ],
            "/api/federation/admin": [
                "admin-surface-limiter",
                route("../routes/federationAdmin"),
            ],
            "/rest": ["urlencoded-middleware", route("../routes/subsonic")],
        };

        for (const [prefix, chain] of Object.entries(expectedMounts)) {
            const call = mocks.app.use.mock.calls.find(
                (args: unknown[]) => args[0] === prefix,
            );
            if (!call) {
                throw new Error(`Expected mount missing: ${prefix}`);
            }
            try {
                expect(call.slice(1)).toEqual(chain);
            } catch (error) {
                throw new Error(
                    `Mount chain mismatch for ${prefix}: ${
                        (error as Error).message
                    }`,
                );
            }
        }

        expect(
            mocks.app.use.mock.calls.map((args: unknown[]) => args[0]),
        ).not.toContain("/api/spotify");

        // Completeness: any new path-prefixed mount must be added to the
        // contract table above so its auth/limiter posture is reviewed.
        const knownUnlisted = new Set(["/api/docs", "/api/admin/queues"]);
        const mountedPaths = mocks.app.use.mock.calls
            .map((args: unknown[]) => args[0])
            .filter(
                (first): first is string =>
                    typeof first === "string" && first.startsWith("/"),
            );
        for (const prefix of mountedPaths) {
            if (
                !Object.prototype.hasOwnProperty.call(expectedMounts, prefix) &&
                !knownUnlisted.has(prefix)
            ) {
                throw new Error(
                    `Unreviewed route mount: ${prefix} — add it to the mount contract table with its expected auth/limiter chain`,
                );
            }
        }

        // Bull Board admin dashboard requires session auth + admin role.
        const queuesCall = mocks.app.use.mock.calls.find(
            (args: unknown[]) => args[0] === "/api/admin/queues",
        );
        expect(queuesCall).toBeDefined();
        expect(queuesCall!.slice(1)).toEqual([
            "admin-surface-limiter",
            mocks.requireAuth,
            mocks.requireAdmin,
            "bull-router",
        ]);
    });

    it("mounts /api/device-link behind the stricter authLimiter", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        jest.spyOn(process, "on").mockImplementation(() => process as any);
        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const call = mocks.app.use.mock.calls.find(
            (args: unknown[]) => args[0] === "/api/device-link",
        );
        expect(call).toBeDefined();
        // device-link/verify is an unauthenticated, full-privilege API-key mint,
        // so it belongs on the auth tier, not the lenient general apiLimiter.
        expect(call![1]).toBe("auth-limiter");
    });

    it("applies safe path and cache-control exclusions in compression filter", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const compressionConfig = (mocks.compressionMiddleware as any).mock
            .calls[0][0] as { filter: (req: any, res: any) => boolean };
        expect(compressionConfig).toBeDefined();
        expect(typeof compressionConfig.filter).toBe("function");

        const cacheRes = {
            getHeader: jest.fn<any, any>(() => undefined),
        };

        expect(
            compressionConfig.filter(
                { path: "/api/audiobooks/book-1/stream" },
                cacheRes,
            ),
        ).toBe(false);
        expect(
            compressionConfig.filter(
                { path: "/api/audiobooks/book-1/cover" },
                cacheRes,
            ),
        ).toBe(false);
        expect(
            compressionConfig.filter(
                { path: "/api/library/tracks/track-1/stream" },
                cacheRes,
            ),
        ).toBe(false);

        expect(compressionConfig.filter({ path: "/api/mixes" }, cacheRes)).toBe(
            true,
        );
        expect(mocks.compressionFilter).toHaveBeenCalledWith(
            { path: "/api/mixes" },
            cacheRes,
        );

        cacheRes.getHeader.mockReturnValueOnce("public, no-transform");
        expect(compressionConfig.filter({ path: "/api/mixes" }, cacheRes)).toBe(
            false,
        );
    });

    it("exits early when BACKEND_PROCESS_ROLE is worker on API entrypoint", () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "worker",
        };

        const exitError = new Error("EXIT");
        process.exit = jest.fn(() => {
            throw exitError;
        }) as any;

        setupApiEntrypointMocks();

        expect(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require("../index");
        }).toThrow(exitError);
    });

    it('warns and defaults BACKEND_PROCESS_ROLE to "all" for invalid values', async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "invalid-role",
        };

        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockImplementation(() => 1 as unknown as NodeJS.Timeout);
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            '[Startup] Invalid BACKEND_PROCESS_ROLE="invalid-role", defaulting to "all"',
        );
        expect(mocks.setupListenTogetherSocket).toHaveBeenCalledWith(
            mocks.server,
        );
        expect(mocks.startPersistLoop).toHaveBeenCalledTimes(1);
        expect(setIntervalSpy).toHaveBeenCalled();
    });

    it("returns 503 on readiness endpoints when startup has not completed", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks({
            invokeListenCallback: false,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const healthReady = getGetHandler(mocks.app, "/health/ready");
        const apiHealthReady = getGetHandler(mocks.app, "/api/health/ready");
        const legacyHealth = getGetHandler(mocks.app, "/health");
        const apiHealth = getGetHandler(mocks.app, "/api/health");
        const liveHealth = getGetHandler(mocks.app, "/health/live");
        const readyRes = createJsonRes();
        const apiReadyRes = createJsonRes();
        const legacyRes = createJsonRes();
        const apiHealthRes = createJsonRes();
        const liveRes = createJsonRes();

        await healthReady({}, readyRes);
        await apiHealthReady({}, apiReadyRes);
        await legacyHealth({}, legacyRes);
        await apiHealth({}, apiHealthRes);
        liveHealth({}, liveRes);

        expect(readyRes.statusCode).toBe(503);
        expect(apiReadyRes.statusCode).toBe(503);
        expect(legacyRes.statusCode).toBe(503);
        expect(apiHealthRes.statusCode).toBe(503);
        expect(readyRes.body).toMatchObject({
            role: "api",
            startupComplete: false,
            draining: false,
        });
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.body).toMatchObject({
            role: "api",
            startupComplete: false,
        });
    });

    it("returns 503 and logs when dependency readiness probe throws from health endpoints", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };
        process.exit = jest.fn() as any;

        const probe = jest
            .fn()
            .mockResolvedValueOnce({
                required: true,
                overallHealthy: true,
                postgres: { ok: true },
                redis: { ok: true },
            })
            .mockRejectedValueOnce(new Error("readiness-probe-failed"));

        const mocks = setupApiEntrypointMocks({
            dependencyProbeImpl: probe,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const healthHandler = getGetHandler(mocks.app, "/health");
        const res = createJsonRes();

        await healthHandler({}, res);

        expect(res.statusCode).toBe(503);
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "[Startup] readiness probe failed:",
            expect.any(Error),
        );
    });

    it("returns 200 payloads for legacy and API health/readiness routes when healthy", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockImplementation(() => 1 as unknown as NodeJS.Timeout);
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const health = getGetHandler(mocks.app, "/health");
        const apiHealth = getGetHandler(mocks.app, "/api/health");
        const healthReady = getGetHandler(mocks.app, "/health/ready");
        const apiHealthReady = getGetHandler(mocks.app, "/api/health/ready");
        const healthLive = getGetHandler(mocks.app, "/health/live");
        const apiHealthLive = getGetHandler(mocks.app, "/api/health/live");

        const healthRes = createJsonRes();
        const apiHealthRes = createJsonRes();
        const readyRes = createJsonRes();
        const apiReadyRes = createJsonRes();
        const liveRes = createJsonRes();
        const apiLiveRes = createJsonRes();

        await health({}, healthRes);
        await apiHealth({}, apiHealthRes);
        await healthReady({}, readyRes);
        await apiHealthReady({}, apiReadyRes);
        healthLive({}, liveRes);
        apiHealthLive({}, apiLiveRes);

        expect(healthRes.statusCode).toBe(200);
        expect(apiHealthRes.statusCode).toBe(200);
        expect(readyRes.statusCode).toBe(200);
        expect(apiReadyRes.statusCode).toBe(200);
        expect(liveRes.statusCode).toBe(200);
        expect(apiLiveRes.statusCode).toBe(200);
        expect(apiReadyRes.body).toMatchObject({
            role: "api",
            startupComplete: true,
            draining: false,
        });
        expect(setIntervalSpy).toHaveBeenCalled();
    });

    it("gracefully shuts down on SIGTERM and ignores duplicate shutdown signals", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "all",
        };

        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const sigtermHandler = getProcessHandler(processOnSpy, "SIGTERM");
        await sigtermHandler();
        await flushPromises();
        await sigtermHandler();
        await flushPromises();

        expect(mocks.stopPersistLoop).toHaveBeenCalledTimes(1);
        expect(mocks.persistAllGroups).toHaveBeenCalledTimes(1);
        expect(mocks.shutdownListenTogetherSocket).toHaveBeenCalledTimes(1);
        expect(mocks.server.close).toHaveBeenCalledTimes(1);
        expect(mocks.server.closeIdleConnections).toHaveBeenCalledTimes(1);
        expect(mocks.shutdownUmapProjection).toHaveBeenCalledTimes(1);
        expect(mocks.shutdownWorkers).toHaveBeenCalledTimes(1);
        expect(mocks.redisClient.close).toHaveBeenCalledTimes(1);
        expect(
            mocks.shutdownUmapProjection.mock.invocationCallOrder[0],
        ).toBeLessThan(mocks.redisClient.close.mock.invocationCallOrder[0]);
        expect(mocks.prisma.$disconnect).toHaveBeenCalled();
        expect(process.exit).toHaveBeenCalledWith(0);
        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Shutdown already in progress...",
        );
    });

    it("logs shutdown cleanup errors and exits non-zero", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "all",
        };

        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks({
            redisCloseImpl: async () => {
                throw new Error("close-failed");
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const sigintHandler = getProcessHandler(processOnSpy, "SIGINT");
        await sigintHandler();
        await flushPromises();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Error during shutdown:",
            expect.any(Error),
        );
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("logs global unhandled rejection and uncaught exception handlers", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        jest.spyOn(global, "setInterval").mockImplementation(
            () => 1 as unknown as NodeJS.Timeout,
        );
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const unhandledRejection = getProcessHandler(
            processOnSpy,
            "unhandledRejection",
        );
        const uncaughtException = getProcessHandler(
            processOnSpy,
            "uncaughtException",
        );

        unhandledRejection(
            new Error("api-unhandled-rejection"),
            Promise.resolve(),
        );
        uncaughtException(new Error("api-uncaught-exception"));
        await flushPromises();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Unhandled Promise Rejection:",
            expect.objectContaining({
                reason: "api-unhandled-rejection",
            }),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Uncaught Exception - initiating graceful shutdown:",
            expect.objectContaining({
                message: "api-uncaught-exception",
            }),
        );
    });

    it("runs interval dependency checks and reconnects PostgreSQL when unhealthy", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockImplementation(() => 1 as unknown as NodeJS.Timeout);
        process.exit = jest.fn() as any;

        const probe = jest
            .fn()
            .mockResolvedValueOnce({
                required: true,
                overallHealthy: true,
                postgres: { ok: true },
                redis: { ok: true },
            })
            .mockResolvedValueOnce({
                required: true,
                overallHealthy: false,
                postgres: { ok: false },
                redis: { ok: true },
            })
            .mockResolvedValueOnce({
                required: true,
                overallHealthy: true,
                postgres: { ok: true },
                redis: { ok: true },
            });

        const mocks = setupApiEntrypointMocks({
            dependencyProbeImpl: probe,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const intervalCallback = setIntervalSpy.mock.calls[0]?.[0] as
            | (() => Promise<void>)
            | undefined;
        expect(intervalCallback).toBeDefined();
        await intervalCallback?.();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Readiness dependency check failed:",
            expect.objectContaining({
                postgres: { ok: false },
                redis: { ok: true },
            }),
        );
        expect(mocks.prisma.$disconnect).toHaveBeenCalled();
        expect(mocks.prisma.$connect).toHaveBeenCalled();
        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Database connection recovered",
        );
    });

    it("logs reconnect and interval probe failures during periodic dependency checks", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockImplementation(() => 1 as unknown as NodeJS.Timeout);
        process.exit = jest.fn() as any;

        let probeCall = 0;
        const probe = jest.fn(async () => {
            probeCall += 1;
            if (probeCall === 1) {
                return {
                    required: true,
                    overallHealthy: true,
                    postgres: { ok: true },
                    redis: { ok: true },
                };
            }
            if (probeCall === 2) {
                return {
                    required: true,
                    overallHealthy: false,
                    postgres: { ok: false },
                    redis: { ok: true },
                };
            }
            throw new Error("interval-probe-failure");
        });

        const mocks = setupApiEntrypointMocks({
            dependencyProbeImpl: probe,
            prismaConnectImpl: async () => {
                throw new Error("reconnect-failure");
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const intervalCallback = setIntervalSpy.mock.calls[0]?.[0] as
            | (() => Promise<void>)
            | undefined;
        expect(intervalCallback).toBeDefined();

        await intervalCallback?.();
        await intervalCallback?.();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Failed to recover database connection:",
            expect.any(Error),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Health check failed - connections may be stale:",
            expect.objectContaining({
                error: "interval-probe-failure",
            }),
        );
    });

    it("exits startup when PostgreSQL startup check fails", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks({
            prismaQueryRawImpl: async () => {
                throw new Error("postgres-down");
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            "✗ PostgreSQL connection failed:",
            expect.objectContaining({
                error: "postgres-down",
            }),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Unable to connect to PostgreSQL. Please ensure:",
        );
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(mocks.prisma.$queryRaw).toHaveBeenCalled();
    });

    it("aborts startup when Redis readiness checks exhaust retries", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation((callback: (...args: any[]) => void) => {
                callback();
                return 1 as unknown as NodeJS.Timeout;
            });
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks();
        mocks.redisClient.isReady = false;
        mocks.redisClient.ping = jest.fn(async () => {
            throw new Error("redis-down");
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Redis connection attempt 1/10 failed"),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "✗ Redis connection failed after all retries:",
            expect.objectContaining({
                error: expect.stringContaining("Redis client is not ready"),
            }),
        );
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(mocks.redisClient.ping).not.toHaveBeenCalled();
        expect(setTimeoutSpy).toHaveBeenCalledTimes(9);
    });

    it("requires auth middleware for API docs in production without DOCS_PUBLIC", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockImplementation(() => 1 as unknown as NodeJS.Timeout);
        process.exit = jest.fn() as any;

        const mocks = setupApiEntrypointMocks({
            configOverrides: {
                nodeEnv: "production",
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const docsEndpoint = mocks.app.use.mock.calls.find(
            (args) => args[0] === "/api/docs",
        );
        const docsJsonEndpoint = mocks.app.get.mock.calls.find(
            (args) => args[0] === "/api/docs.json",
        );

        expect(docsEndpoint?.[1]).toBe("swagger-serve-middleware");
        expect(docsJsonEndpoint?.[1]).toBe(mocks.requireAuth);
        expect(docsEndpoint?.length).toBeGreaterThan(2);
        expect(setIntervalSpy).toHaveBeenCalled();
    });

    it("hashes and updates admin password when ADMIN_RESET_PASSWORD is set", async () => {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "api",
        };

        const setIntervalSpy = jest
            .spyOn(global, "setInterval")
            .mockImplementation(() => 1 as unknown as NodeJS.Timeout);
        process.exit = jest.fn() as any;

        const adminPasswordHash = jest.fn(
            async (_value: string, _salt: number) => "hashed-admin-pass",
        );
        const mocks = setupApiEntrypointMocks({
            bcryptHashImpl: adminPasswordHash,
            configOverrides: {
                adminResetPassword: "new-admin-password",
            },
        });

        mocks.prisma.user.findFirst.mockResolvedValue({
            id: "admin-id",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        // Roles are stored lowercase ("user" / "admin" — see prisma schema
        // default and routes/auth/adminUserInvites.ts validation). Querying "ADMIN" made the
        // emergency reset a silent no-op.
        expect(mocks.prisma.user.findFirst).toHaveBeenCalledWith({
            where: { role: "admin" },
        });
        expect(adminPasswordHash).toHaveBeenCalledWith(
            "new-admin-password",
            10,
        );
        expect(mocks.prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "admin-id" },
                data: {
                    passwordHash: "hashed-admin-pass",
                    tokenVersion: { increment: 1 },
                    subsonicPassword: null,
                },
            }),
        );
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "[Password Reset] Admin password has been reset via ADMIN_RESET_PASSWORD env var. Remove this env var and restart.",
        );
        expect(setIntervalSpy).toHaveBeenCalled();
    });
});
