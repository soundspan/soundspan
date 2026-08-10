import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { AppError, ErrorCategory } from "../utils/errors";
import { config } from "../config";

const log = logger.child("ErrorHandler");

/** Maps application/runtime errors to consistent HTTP responses and logging. */
export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    next: NextFunction,
) {
    // Handle AppError with proper categorization
    if (err instanceof AppError) {
        // An explicit httpStatus (e.g. 401/404/409) wins over the
        // category->status map below, which can only express 400/503/500.
        // No explicit status set => identical behavior to before.
        let statusCode: number;
        if (err.httpStatus !== undefined) {
            statusCode = err.httpStatus;
        } else {
            statusCode = 500;
            switch (err.category) {
                case ErrorCategory.RECOVERABLE:
                    statusCode = 400; // Bad Request - client can retry with changes
                    break;
                case ErrorCategory.TRANSIENT:
                    statusCode = 503; // Service Unavailable - client can retry later
                    break;
                case ErrorCategory.FATAL:
                    statusCode = 500; // Internal Server Error - cannot recover
                    break;
            }
        }

        log.error(`AppError ${err.code}: ${err.message}`, err.details);

        return res.status(statusCode).json({
            error: err.message,
            code: err.code,
            category: err.category,
            ...(config.nodeEnv === "development" && { details: err.details }),
        });
    }

    // Log stack trace for unhandled errors. Include req.method + req.path so
    // the log line still identifies the failing route once callers migrate
    // to asyncHandler and lose their per-site try/catch log context (F1).
    log.error("Unhandled error:", `${req.method} ${req.path}`, err.stack);

    // In production, hide stack traces and internal details
    if (config.nodeEnv === "production") {
        return res.status(500).json({ error: "Internal server error" });
    }

    // In development, provide more details
    res.status(500).json({
        error: err.message || "Internal server error",
        stack: err.stack,
    });
}
