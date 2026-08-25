import { Registry } from "prom-client";
import { createVibeEmbedMetrics } from "../metrics/vibeEmbedMetrics";

describe("worker entrypoint behavior", () => {
    const originalEnv = process.env;
    const originalExit = process.exit;
    const HEALTH_INTERVAL_MS = 5 * 60 * 1000;

    afterEach(() => {
        process.env = originalEnv;
        process.exit = originalExit;
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupWorkerRuntime({
        envOverrides,
        dependencyProbeImpl,
        dependencyHealthy = true,
        redisIsReady = true,
        redisPingImpl,
        redisCloseImpl,
        prismaQueryRawImpl,
        prismaDisconnectImpl,
        prismaConnectImpl,
        initializeMusicConfigImpl,
        shutdownWorkersImpl,
        processExitImpl,
        metricsRegistryOverride,
        discoveryMode = "recommendation",
    }: {
        envOverrides?: Record<string, string>;
        dependencyProbeImpl?: () => Promise<any>;
        dependencyHealthy?: boolean;
        redisIsReady?: boolean;
        redisPingImpl?: () => Promise<unknown>;
        redisCloseImpl?: () => Promise<unknown>;
        prismaQueryRawImpl?: () => Promise<unknown>;
        prismaDisconnectImpl?: () => Promise<unknown>;
        prismaConnectImpl?: () => Promise<unknown>;
        initializeMusicConfigImpl?: () => Promise<unknown>;
        shutdownWorkersImpl?: () => Promise<unknown>;
        processExitImpl?: (...args: any[]) => never | void;
        metricsRegistryOverride?: {
            contentType: string;
            metrics(): Promise<string>;
        };
        discoveryMode?: "legacy" | "recommendation";
    } = {}) {
        process.env = {
            ...originalEnv,
            BACKEND_PROCESS_ROLE: "worker",
            WORKER_HEALTH_PORT: "3010",
            ...envOverrides,
        };
        jest.useFakeTimers();

        const probe = jest.fn(
            dependencyProbeImpl ||
                (async () => ({
                    required: true,
                    overallHealthy: true,
                    postgres: { ok: true },
                    redis: { ok: true },
                    checkedAt: new Date().toISOString(),
                })),
        );
        const dependencyReadiness = {
            probe,
            isHealthy: jest.fn(() => dependencyHealthy),
            getSnapshot: jest.fn(() => ({
                required: true,
                overallHealthy: dependencyHealthy,
                postgres: { ok: true },
                redis: { ok: true },
            })),
        };

        let requestHandler:
            | ((
                  req: { url?: string; headers?: { authorization?: string } },
                  res: any,
              ) => void)
            | null = null;
        const server = {
            on: jest.fn(),
            listen: jest.fn((_port, _host, cb?: () => void) => cb?.()),
            close: jest.fn((cb?: () => void) => cb?.()),
        };
        const createServer = jest.fn((handler) => {
            requestHandler = handler;
            return server;
        });

        const prisma = {
            $queryRaw: jest.fn(prismaQueryRawImpl || (async () => 1)),
            $disconnect: jest.fn(
                prismaDisconnectImpl || (async () => undefined),
            ),
            $connect: jest.fn(prismaConnectImpl || (async () => undefined)),
        };

        const redisClient = {
            isReady: redisIsReady,
            ping: jest.fn(redisPingImpl || (async () => "PONG")),
            close: jest.fn(redisCloseImpl || (async () => "OK")),
        };

        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);
        const createDependencyReadinessTracker = jest.fn(
            () => dependencyReadiness,
        );

        const exitMock = jest.fn(processExitImpl || (() => undefined)) as any;
        process.exit = exitMock;

        const shutdownWorkers = jest.fn(
            shutdownWorkersImpl || (async () => undefined),
        );
        const startWorkers = jest.fn();

        jest.doMock("http", () => ({
            createServer,
        }));
        jest.doMock("../config", () => ({
            config: {
                databaseUrl:
                    "postgresql://soundspan:secret@db.example:5432/soundspan",
                redisUrl: "redis://redis.example:6379/0",
                workerEventLoop: {
                    warnThresholdMs: 1000,
                    sampleIntervalMs: 5000,
                },
                metrics: { token: "metrics-token", publicAccess: false },
                discover: { mode: discoveryMode },
            },
            initializeMusicConfig: jest.fn(
                initializeMusicConfigImpl || (async () => undefined),
            ),
        }));
        jest.doMock("../utils/redis", () => ({ redisClient }));
        jest.doMock("../utils/db", () => ({ prisma }));
        jest.doMock("../services/federationCredentials", () => ({
            backfillFederationOutboundTokens: jest.fn().mockResolvedValue(0),
        }));
        jest.doMock("../utils/logger", () => ({ logger }));
        jest.doMock("../utils/dependencyReadiness", () => ({
            createDependencyReadinessTracker,
        }));
        jest.doMock("../workers", () => ({
            startWorkers,
            shutdownWorkers,
        }));
        const metricsRegistry =
            metricsRegistryOverride ??
            ({
                contentType: "text/plain; version=0.0.4; charset=utf-8",
                metrics: jest.fn(async () => "soundspan_test_metric 1\n"),
            } as const);
        const registerQueueMetrics = jest.fn();
        const initializeFederationMetrics = jest.fn();
        jest.doMock("../metrics", () => ({
            initializeFederationMetrics,
            metricsRegistry,
        }));
        jest.doMock("../metrics/endpoint", () => ({
            isMetricsRequestAuthorized: (authorization: string | undefined) =>
                authorization === "Bearer metrics-token",
        }));
        jest.doMock("../metrics/queueMetrics", () => ({
            registerQueueMetrics,
        }));
        jest.doMock("../workers/queues", () => ({ queues: [] }));

        return {
            requestHandler: () => requestHandler,
            createServer,
            server,
            prisma,
            redisClient,
            logger,
            dependencyReadiness,
            shutdownWorkers,
            exitMock,
            createDependencyReadinessTracker,
            metricsRegistry,
            registerQueueMetrics,
            initializeFederationMetrics,
        };
    }

    function createHealthRes() {
        return {
            writeHead: jest.fn(),
            end: jest.fn(),
        };
    }

    const flushWorkerTicks = async (): Promise<void> => {
        await Promise.resolve();
        await Promise.resolve();
    };

    const waitForResponse = async (res: { writeHead: jest.Mock }) => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (res.writeHead.mock.calls.length > 0) return;
            await Promise.resolve();
        }
    };

    const waitForWorkerReadyLog = async (
        logger: { info: jest.Mock },
        maxAttempts = 20,
    ): Promise<void> => {
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            if (
                logger.info.mock.calls.some(
                    ([message]) => message === "Worker runtime initialized",
                )
            ) {
                return;
            }
            await flushWorkerTicks();
        }
    };

    it("starts health server and initializes worker runtime with healthy dependencies", async () => {
        const {
            createServer,
            server,
            prisma,
            redisClient,
            exitMock,
            createDependencyReadinessTracker,
            initializeFederationMetrics,
        } = setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();

        expect(createServer).toHaveBeenCalledTimes(1);
        expect(server.listen).toHaveBeenCalledWith(
            3010,
            "0.0.0.0",
            expect.any(Function),
        );
        expect(prisma.$queryRaw).toHaveBeenCalled();
        expect(redisClient.ping).toHaveBeenCalled();
        expect(createDependencyReadinessTracker).toHaveBeenCalledWith("worker");
        expect(initializeFederationMetrics).toHaveBeenCalledWith("worker");
        expect(exitMock).not.toHaveBeenCalled();
    });

    it("warns once when the worker starts in legacy discovery mode", async () => {
        const { logger } = setupWorkerRuntime({ discoveryMode: "legacy" });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();

        const deprecatedWarnings = logger.warn.mock.calls.filter(([message]) =>
            String(message).includes("deprecated"),
        );
        expect(deprecatedWarnings).toHaveLength(1);
        expect(String(deprecatedWarnings[0][0])).toContain(
            "now serves the modern discovery implementation",
        );
    });

    it('fails fast when BACKEND_PROCESS_ROLE="api" is used on worker entrypoint', async () => {
        const { exitMock, logger, createServer } = setupWorkerRuntime({
            envOverrides: { BACKEND_PROCESS_ROLE: "api" },
            processExitImpl: () => {
                throw new Error("exit-1");
            },
        });

        expect(() => require("../worker")).toThrow("exit-1");
        expect(exitMock).toHaveBeenCalledWith(1);
        expect(logger.error).toHaveBeenCalledWith(
            'BACKEND_PROCESS_ROLE="api" is invalid for worker entrypoint.',
        );
        expect(createServer).not.toHaveBeenCalled();
    });

    it("warns and defaults to worker role for invalid BACKEND_PROCESS_ROLE", async () => {
        const { logger } = setupWorkerRuntime({
            envOverrides: { BACKEND_PROCESS_ROLE: "invalid-role" },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await Promise.resolve();
        await Promise.resolve();

        expect(logger.warn).toHaveBeenCalledWith(
            'Invalid BACKEND_PROCESS_ROLE="invalid-role", defaulting to "worker"',
        );
    });

    it("warns and defaults WORKER_HEALTH_PORT when configured port is invalid", async () => {
        const { logger, server } = setupWorkerRuntime({
            envOverrides: { WORKER_HEALTH_PORT: "bad-port" },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await Promise.resolve();
        await Promise.resolve();

        expect(server.listen).toHaveBeenCalledWith(
            3010,
            "0.0.0.0",
            expect.any(Function),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            'Invalid WORKER_HEALTH_PORT="bad-port", defaulting to 3010',
        );
    });

    it("serves health routes with expected live/ready/not-found semantics", async () => {
        const { requestHandler } = setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await Promise.resolve();
        await Promise.resolve();

        const handler = requestHandler();
        expect(handler).toBeTruthy();

        const liveRes = {
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handler!({ url: "/health/live", headers: {} }, liveRes);
        expect(liveRes.writeHead).toHaveBeenCalledWith(200, {
            "Content-Type": "application/json",
        });

        const readyRes = {
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handler!({ url: "/health/ready", headers: {} }, readyRes);
        await Promise.resolve();
        await Promise.resolve();
        expect([200, 503]).toContain(readyRes.writeHead.mock.calls[0]?.[0]);
        expect(readyRes.writeHead.mock.calls[0]?.[1]).toEqual({
            "Content-Type": "application/json",
        });

        const missingRes = {
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handler!({ url: "/unknown", headers: {} }, missingRes);
        expect(missingRes.writeHead).toHaveBeenCalledWith(404, {
            "Content-Type": "application/json",
        });
        expect(missingRes.end).toHaveBeenCalledWith(
            JSON.stringify({ error: "Not found" }),
        );
    });

    it("serves worker metrics only with the configured bearer token", async () => {
        const { requestHandler, metricsRegistry } = setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();

        const handler = requestHandler();
        const unauthorized = createHealthRes();
        handler!({ url: "/metrics", headers: {} }, unauthorized);
        await flushWorkerTicks();
        expect(unauthorized.writeHead).toHaveBeenCalledWith(
            401,
            expect.objectContaining({
                "WWW-Authenticate": 'Bearer realm="metrics"',
            }),
        );

        const authorized = createHealthRes();
        handler!(
            {
                url: "/metrics",
                headers: { authorization: "Bearer metrics-token" },
            },
            authorized,
        );
        await flushWorkerTicks();
        expect(metricsRegistry.metrics).toHaveBeenCalledTimes(1);
        expect(authorized.writeHead).toHaveBeenCalledWith(200, {
            "Content-Type": metricsRegistry.contentType,
        });
        expect(authorized.end).toHaveBeenCalledWith(
            "soundspan_test_metric 1\n",
        );
    });

    it("serves worker metrics when the vibe queue collector cannot reach Redis", async () => {
        const registry = new Registry();
        createVibeEmbedMetrics(registry, {
            getProviderQueueDepth: async () => {
                throw new Error("redis unavailable");
            },
            getProviderStatusFresh: async () => false,
        });
        const { requestHandler } = setupWorkerRuntime({
            metricsRegistryOverride: registry,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();
        const handler = requestHandler();
        const firstResponse = createHealthRes();
        handler!(
            {
                url: "/metrics",
                headers: { authorization: "Bearer metrics-token" },
            },
            firstResponse,
        );
        await waitForResponse(firstResponse);
        expect(firstResponse.writeHead).toHaveBeenCalledWith(200, {
            "Content-Type": registry.contentType,
        });

        const response = createHealthRes();
        handler!(
            {
                url: "/metrics",
                headers: { authorization: "Bearer metrics-token" },
            },
            response,
        );
        await waitForResponse(response);

        expect(response.writeHead).toHaveBeenCalledWith(200, {
            "Content-Type": registry.contentType,
        });
        expect(response.end.mock.calls[0]?.[0]).toMatch(
            /soundspan_metrics_collection_errors_total\{collector="vibe_queue_depth"\} [1-9][0-9]*/,
        );
    });

    it("returns 200 on ready routes when startup and dependencies are healthy", async () => {
        const { requestHandler } = setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();
        await flushWorkerTicks();

        const handler = requestHandler();
        let statusCode: number | undefined;
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const readyRes = createHealthRes();
            handler!({ url: "/health/ready" }, readyRes);
            await flushWorkerTicks();
            statusCode = readyRes.writeHead.mock.calls[0]?.[0];
            if (statusCode === 200) {
                break;
            }
            await flushWorkerTicks();
        }

        expect(statusCode).toBe(200);
    });

    it("logs readiness probe failures for ready routes after startup completes", async () => {
        const probe = jest
            .fn()
            .mockResolvedValueOnce({
                required: true,
                overallHealthy: true,
                postgres: { ok: true },
                redis: { ok: true },
                checkedAt: new Date().toISOString(),
            })
            .mockRejectedValueOnce(new Error("ready-probe-failed"));
        const { requestHandler, logger } = setupWorkerRuntime({
            dependencyProbeImpl: probe,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();
        await flushWorkerTicks();

        const handler = requestHandler();
        const readyRes = createHealthRes();
        handler!({ url: "/health/ready" }, readyRes);
        await flushWorkerTicks();

        expect(readyRes.writeHead).toHaveBeenCalledWith(503, {
            "Content-Type": "application/json",
        });
        expect(logger.error).toHaveBeenCalledWith(
            "readiness probe failed:",
            expect.any(Error),
        );
    });

    it("supports /health alias and returns 503 when readiness probe throws", async () => {
        const probe = jest
            .fn()
            .mockResolvedValueOnce({
                required: true,
                overallHealthy: true,
                postgres: { ok: true },
                redis: { ok: true },
                checkedAt: new Date().toISOString(),
            })
            .mockRejectedValueOnce(new Error("probe-failed"));
        const { requestHandler } = setupWorkerRuntime({
            dependencyProbeImpl: probe,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await Promise.resolve();
        await Promise.resolve();

        const handler = requestHandler();
        const healthRes = createHealthRes();
        handler!({ url: "/health" }, healthRes);
        await flushWorkerTicks();

        expect(healthRes.writeHead).toHaveBeenCalledWith(503, {
            "Content-Type": "application/json",
        });
        expect(probe).toHaveBeenCalled();
    });

    it("logs health-server error events", async () => {
        const { server, logger } = setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await Promise.resolve();
        await Promise.resolve();

        const errorHandler = server.on.mock.calls.find(
            ([event]: [string]) => event === "error",
        )?.[1] as ((error: Error) => void) | undefined;

        expect(errorHandler).toBeDefined();
        errorHandler?.(new Error("health-server-failed"));

        expect(logger.error).toHaveBeenCalledWith(
            "Health server error:",
            expect.any(Error),
        );
    });

    it("logs unhandled promise rejections", async () => {
        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        const { logger } = setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();

        const unhandledRejectionHandler = processOnSpy.mock.calls.find(
            ([event]) => event === "unhandledRejection",
        )?.[1] as
            | ((reason: unknown, promise: Promise<unknown>) => void)
            | undefined;
        expect(unhandledRejectionHandler).toBeDefined();

        unhandledRejectionHandler?.(
            new Error("unhandled-rejection"),
            Promise.resolve(),
        );

        expect(logger.error).toHaveBeenCalledWith(
            "Unhandled Promise Rejection:",
            expect.objectContaining({
                reason: "unhandled-rejection",
            }),
        );
    });

    it("logs uncaught exceptions and triggers graceful shutdown", async () => {
        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        const { logger } = setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();

        const uncaughtExceptionHandler = processOnSpy.mock.calls.find(
            ([event]) => event === "uncaughtException",
        )?.[1] as ((error: Error) => void) | undefined;
        expect(uncaughtExceptionHandler).toBeDefined();

        uncaughtExceptionHandler?.(new Error("uncaught-boom"));
        await flushWorkerTicks();

        expect(logger.error).toHaveBeenCalledWith(
            "Uncaught Exception - initiating graceful worker shutdown:",
            expect.objectContaining({
                message: "uncaught-boom",
            }),
        );
    });

    it("returns ready=503 when startup has not completed yet", async () => {
        const { requestHandler, dependencyReadiness } = setupWorkerRuntime({
            dependencyProbeImpl: async () => ({
                required: true,
                overallHealthy: false,
                postgres: { ok: false },
                redis: { ok: true },
                checkedAt: new Date().toISOString(),
            }),
            dependencyHealthy: false,
            prismaQueryRawImpl: async () => {
                throw new Error("db startup fail");
            },
        });

        // prevent module crash from fatal startup path
        const modLoad = () => require("../worker");
        expect(modLoad).not.toThrow();
        await Promise.resolve();

        const handler = requestHandler();
        const readyRes = {
            writeHead: jest.fn(),
            end: jest.fn(),
        };
        handler!({ url: "/health/ready" }, readyRes);
        await Promise.resolve();
        await Promise.resolve();

        expect(dependencyReadiness.probe).toHaveBeenCalled();
        expect(readyRes.writeHead).toHaveBeenCalledWith(503, {
            "Content-Type": "application/json",
        });
    });

    it("retries redis ping with backoff and then recovers", async () => {
        const ping = jest
            .fn()
            .mockRejectedValueOnce(new Error("ping failed"))
            .mockResolvedValueOnce("PONG");

        const { redisClient, logger } = setupWorkerRuntime({
            redisPingImpl: ping,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");

        await jest.advanceTimersByTimeAsync(1_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(redisClient.ping).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Redis connection attempt 1/10 failed"),
        );
    });

    it("logs and exits when redis remains unavailable after max retries", async () => {
        const { logger, exitMock } = setupWorkerRuntime({
            redisIsReady: false,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");

        await jest.advanceTimersByTimeAsync(100_000);
        await flushWorkerTicks();

        expect(logger.error).toHaveBeenCalledWith(
            "✗ Redis connection failed after all retries:",
            expect.objectContaining({
                error: "Redis client is not ready - connection failed or still connecting",
            }),
        );
        expect(exitMock).toHaveBeenCalledWith(1);
    });

    it("runs interval dependency checks and attempts DB recovery when postgres turns unhealthy", async () => {
        const probe = jest
            .fn()
            .mockResolvedValueOnce({
                required: true,
                overallHealthy: true,
                postgres: { ok: true },
                redis: { ok: true },
                checkedAt: new Date().toISOString(),
            })
            .mockResolvedValueOnce({
                required: true,
                overallHealthy: false,
                postgres: { ok: false },
                redis: { ok: true },
                checkedAt: new Date().toISOString(),
            })
            .mockResolvedValueOnce({
                required: true,
                overallHealthy: true,
                postgres: { ok: true },
                redis: { ok: true },
                checkedAt: new Date().toISOString(),
            });
        const { prisma } = setupWorkerRuntime({
            dependencyProbeImpl: probe,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await Promise.resolve();
        await Promise.resolve();

        await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
        await Promise.resolve();
        await Promise.resolve();

        expect(prisma.$disconnect).toHaveBeenCalled();
        expect(prisma.$connect).toHaveBeenCalled();
    });

    it("logs reconnect failure and subsequent interval probe failures", async () => {
        let probeCall = 0;
        const probe = jest.fn(async () => {
            probeCall += 1;
            if (probeCall === 1) {
                return {
                    required: true,
                    overallHealthy: true,
                    postgres: { ok: true },
                    redis: { ok: true },
                    checkedAt: new Date().toISOString(),
                };
            }
            if (probeCall === 2) {
                return {
                    required: true,
                    overallHealthy: false,
                    postgres: { ok: false },
                    redis: { ok: true },
                    checkedAt: new Date().toISOString(),
                };
            }
            throw new Error("worker-interval-probe-failed");
        });
        const { logger } = setupWorkerRuntime({
            dependencyProbeImpl: probe,
            prismaConnectImpl: async () => {
                throw new Error("worker-reconnect-failed");
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();

        await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
        await flushWorkerTicks();
        await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
        await flushWorkerTicks();

        expect(logger.error).toHaveBeenCalledWith(
            "Worker failed to recover database connection:",
            expect.any(Error),
        );
        expect(logger.error).toHaveBeenCalledWith(
            "Worker health check failed - connections may be stale:",
            expect.objectContaining({
                error: "worker-interval-probe-failed",
            }),
        );
    });

    it("stops the health-check interval on graceful shutdown", async () => {
        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        const { dependencyReadiness, logger } = setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await waitForWorkerReadyLog(logger);

        const sigtermHandler = processOnSpy.mock.calls.find(
            ([event]) => event === "SIGTERM",
        )?.[1] as (() => Promise<void>) | undefined;

        expect(sigtermHandler).toBeDefined();
        await sigtermHandler?.();
        await flushWorkerTicks();
        const probeCallCountAfterShutdown =
            dependencyReadiness.probe.mock.calls.length;

        await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2);
        await flushWorkerTicks();

        expect(dependencyReadiness.probe).toHaveBeenCalledTimes(
            probeCallCountAfterShutdown,
        );
    });

    it("closes health server and exits on SIGTERM graceful shutdown", async () => {
        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        const { server, exitMock, logger, shutdownWorkers } =
            setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await waitForWorkerReadyLog(logger);

        const sigtermHandler = processOnSpy.mock.calls.find(
            ([event]) => event === "SIGTERM",
        )?.[1] as (() => Promise<void>) | undefined;

        expect(sigtermHandler).toBeDefined();
        await sigtermHandler?.();
        await sigtermHandler?.();
        await flushWorkerTicks();

        expect(shutdownWorkers).toHaveBeenCalled();
        expect(server.close).toHaveBeenCalled();
        expect(exitMock).toHaveBeenCalledWith(0);
        expect(logger.debug).toHaveBeenCalledWith(
            "Shutdown already in progress...",
        );
    });

    it("shuts down cleanly when SIGINT handler is invoked", async () => {
        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        const { exitMock, logger } = setupWorkerRuntime();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await waitForWorkerReadyLog(logger);

        const sigintHandler = processOnSpy.mock.calls.find(
            ([event]) => event === "SIGINT",
        )?.[1] as (() => Promise<void>) | undefined;

        expect(sigintHandler).toBeDefined();
        await sigintHandler?.();
        await flushWorkerTicks();

        expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("logs shutdown errors and exits with code 1 when redis close fails", async () => {
        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        const { logger, exitMock } = setupWorkerRuntime({
            redisCloseImpl: async () => {
                throw new Error("worker-close-failed");
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();
        await flushWorkerTicks();

        const sigtermHandler = processOnSpy.mock.calls.find(
            ([event]) => event === "SIGTERM",
        )?.[1] as (() => Promise<void>) | undefined;

        expect(sigtermHandler).toBeDefined();
        await sigtermHandler?.();
        await flushWorkerTicks();

        expect(logger.error).toHaveBeenCalledWith(
            "Error during worker shutdown:",
            expect.any(Error),
        );
        expect(exitMock).toHaveBeenCalledWith(1);
    });

    it("falls back to uncaughtException catch exit path when graceful shutdown promise rejects", async () => {
        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        let exitCall = 0;
        const { exitMock } = setupWorkerRuntime({
            processExitImpl: () => {
                exitCall += 1;
                if (exitCall <= 2) {
                    throw new Error(`exit-${exitCall}`);
                }
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();

        const uncaughtExceptionHandler = processOnSpy.mock.calls.find(
            ([event]) => event === "uncaughtException",
        )?.[1] as ((error: Error) => void) | undefined;
        expect(uncaughtExceptionHandler).toBeDefined();

        uncaughtExceptionHandler?.(new Error("force-fallback"));
        await flushWorkerTicks();
        await flushWorkerTicks();

        expect(exitMock).toHaveBeenCalledWith(1);
        expect(exitMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("handles signal shutdown after startup failure already stopped health server", async () => {
        const processOnSpy = jest
            .spyOn(process, "on")
            .mockImplementation(() => process as any);
        const { server, exitMock } = setupWorkerRuntime({
            dependencyProbeImpl: async () => {
                throw new Error("startup-failure");
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../worker");
        await flushWorkerTicks();
        await flushWorkerTicks();

        const sigtermHandler = processOnSpy.mock.calls.find(
            ([event]) => event === "SIGTERM",
        )?.[1] as (() => Promise<void>) | undefined;
        expect(sigtermHandler).toBeDefined();

        await sigtermHandler?.();
        await flushWorkerTicks();

        // Health server is closed during startup failure catch, then stopHealthServer
        // is a no-op during subsequent signal shutdown.
        expect(server.close).toHaveBeenCalledTimes(1);
        expect(exitMock).toHaveBeenCalledWith(1);
        expect(exitMock).toHaveBeenCalledWith(0);
    });
});
