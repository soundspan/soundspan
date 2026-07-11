export {};

const mockLoggerError = jest.fn();

jest.mock("../../utils/logger", () => ({
    logger: {
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

describe("errorHandler middleware", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
    });

    async function loadHandler(nodeEnv: "development" | "production") {
        jest.doMock("../../config", () => ({
            config: { nodeEnv },
        }));
        return import("../errorHandler");
    }

    function createResponse() {
        const res: any = {};
        res.status = jest.fn().mockReturnValue(res);
        res.json = jest.fn().mockReturnValue(res);
        return res;
    }

    function createRequest(overrides: Partial<{ method: string; path: string }> = {}) {
        return { method: "GET", path: "/api/example", ...overrides } as any;
    }

    it("maps AppError categories to status codes and includes details in development", async () => {
        const { errorHandler } = await loadHandler("development");
        const { AppError, ErrorCategory, ErrorCode } = await import(
            "../../utils/errors"
        );

        const resRecoverable = createResponse();
        const recoverable = new AppError(
            ErrorCode.INVALID_CONFIG,
            ErrorCategory.RECOVERABLE,
            "recoverable issue",
            { hint: "fix input" }
        );

        errorHandler(recoverable, createRequest(), resRecoverable, jest.fn());

        expect(resRecoverable.status).toHaveBeenCalledWith(400);
        expect(resRecoverable.json).toHaveBeenCalledWith({
            error: "recoverable issue",
            code: ErrorCode.INVALID_CONFIG,
            category: ErrorCategory.RECOVERABLE,
            details: { hint: "fix input" },
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            `[AppError] ${ErrorCode.INVALID_CONFIG}: recoverable issue`,
            { hint: "fix input" }
        );

        const resTransient = createResponse();
        const transient = new AppError(
            ErrorCode.TRANSCODE_FAILED,
            ErrorCategory.TRANSIENT,
            "retry later"
        );
        errorHandler(transient, createRequest(), resTransient, jest.fn());
        expect(resTransient.status).toHaveBeenCalledWith(503);

        const resFatal = createResponse();
        const fatal = new AppError(
            ErrorCode.MUSIC_PATH_NOT_ACCESSIBLE,
            ErrorCategory.FATAL,
            "fatal error"
        );
        errorHandler(fatal, createRequest(), resFatal, jest.fn());
        expect(resFatal.status).toHaveBeenCalledWith(500);
    });

    it("omits AppError details in production responses", async () => {
        const { errorHandler } = await loadHandler("production");
        const { AppError, ErrorCategory, ErrorCode } = await import(
            "../../utils/errors"
        );
        const res = createResponse();

        errorHandler(
            new AppError(
                ErrorCode.INVALID_CONFIG,
                ErrorCategory.RECOVERABLE,
                "prod-safe",
                { secret: "hide-me" }
            ),
            createRequest(),
            res,
            jest.fn()
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: "prod-safe",
            code: ErrorCode.INVALID_CONFIG,
            category: ErrorCategory.RECOVERABLE,
        });
    });

    it("returns generic 500 for untyped errors in production", async () => {
        const prod = await loadHandler("production");
        const prodRes = createResponse();
        const prodErr = new Error("db exploded");
        prodErr.stack = "stack-trace";
        const req = createRequest({ method: "POST", path: "/api/downloads/123" });

        prod.errorHandler(prodErr, req, prodRes, jest.fn());

        // Unhandled-error logs carry req.method + req.path (F1 P1 mitigation:
        // per-site log context is disappearing as routes migrate to
        // asyncHandler, so the shared errorHandler must supply it instead).
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Unhandled error:",
            "POST /api/downloads/123",
            "stack-trace"
        );
        expect(prodRes.status).toHaveBeenCalledWith(500);
        expect(prodRes.json).toHaveBeenCalledWith({
            error: "Internal server error",
        });
    });

    it("returns stack details for untyped errors in development", async () => {
        const dev = await loadHandler("development");
        const devRes = createResponse();
        const devErr = new Error("dev-visible");
        devErr.stack = "dev-stack";

        dev.errorHandler(devErr, createRequest(), devRes, jest.fn());

        expect(devRes.status).toHaveBeenCalledWith(500);
        expect(devRes.json).toHaveBeenCalledWith({
            error: "dev-visible",
            stack: "dev-stack",
        });
    });

    it("falls back to generic error text in development when Error.message is empty", async () => {
        const dev = await loadHandler("development");
        const res = createResponse();
        const err = new Error("");
        err.stack = "empty-message-stack";

        dev.errorHandler(err, createRequest(), res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: "Internal server error",
            stack: "empty-message-stack",
        });
    });

    it("uses AppError.httpStatus when present, overriding the category-based mapping", async () => {
        const { errorHandler } = await loadHandler("development");
        const { AppError, ErrorCategory, ErrorCode } = await import(
            "../../utils/errors"
        );

        const resUnauthorized = createResponse();
        const unauthorized = new AppError(
            ErrorCode.INTERNAL,
            ErrorCategory.RECOVERABLE,
            "not authorized",
            undefined,
            401
        );
        errorHandler(unauthorized, createRequest(), resUnauthorized, jest.fn());
        expect(resUnauthorized.status).toHaveBeenCalledWith(401);
        expect(resUnauthorized.json).toHaveBeenCalledWith({
            error: "not authorized",
            code: ErrorCode.INTERNAL,
            category: ErrorCategory.RECOVERABLE,
        });

        // FATAL would normally map to 500 (see the category-mapping test
        // above) — pairing it with an explicit 404 proves explicit status
        // wins over the category map, not just that it can produce a 4xx.
        const resNotFound = createResponse();
        const notFound = new AppError(
            ErrorCode.INTERNAL,
            ErrorCategory.FATAL,
            "resource missing",
            undefined,
            404
        );
        errorHandler(notFound, createRequest(), resNotFound, jest.fn());
        expect(resNotFound.status).toHaveBeenCalledWith(404);
        expect(resNotFound.json).toHaveBeenCalledWith({
            error: "resource missing",
            code: ErrorCode.INTERNAL,
            category: ErrorCategory.FATAL,
        });
    });

    it("keeps AppError explicit-status responses shaped the same in production (message included, details dev-gated)", async () => {
        const { errorHandler } = await loadHandler("production");
        const { AppError, ErrorCategory, ErrorCode } = await import(
            "../../utils/errors"
        );
        const res = createResponse();

        errorHandler(
            new AppError(
                ErrorCode.INTERNAL,
                ErrorCategory.RECOVERABLE,
                "not found",
                { secret: "hide-me" },
                404
            ),
            createRequest(),
            res,
            jest.fn()
        );

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
            error: "not found",
            code: ErrorCode.INTERNAL,
            category: ErrorCategory.RECOVERABLE,
        });
    });
});
