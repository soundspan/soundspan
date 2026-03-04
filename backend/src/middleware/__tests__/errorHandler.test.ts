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

        errorHandler(recoverable, {} as any, resRecoverable, jest.fn());

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
        errorHandler(transient, {} as any, resTransient, jest.fn());
        expect(resTransient.status).toHaveBeenCalledWith(503);

        const resFatal = createResponse();
        const fatal = new AppError(
            ErrorCode.MUSIC_PATH_NOT_ACCESSIBLE,
            ErrorCategory.FATAL,
            "fatal error"
        );
        errorHandler(fatal, {} as any, resFatal, jest.fn());
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
            {} as any,
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

        prod.errorHandler(prodErr, {} as any, prodRes, jest.fn());

        expect(mockLoggerError).toHaveBeenCalledWith("Unhandled error:", "stack-trace");
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

        dev.errorHandler(devErr, {} as any, devRes, jest.fn());

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

        dev.errorHandler(err, {} as any, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: "Internal server error",
            stack: "empty-message-stack",
        });
    });
});
