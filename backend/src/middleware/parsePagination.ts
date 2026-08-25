import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface Pagination {
    limit: number;
    offset: number;
}

export interface PaginationOptions {
    defaultLimit?: number;
    maxLimit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

function positiveInteger(value: unknown, fallback: number): number {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown): number {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Parses and clamps `limit`/`offset`, then pins normalized Express 5 query values. */
export function parsePagination(
    options: PaginationOptions = {},
): RequestHandler {
    const maxLimit = Math.max(1, Math.floor(options.maxLimit ?? MAX_LIMIT));
    const defaultLimit = Math.min(
        maxLimit,
        Math.max(1, Math.floor(options.defaultLimit ?? DEFAULT_LIMIT)),
    );

    return (req: Request, _res: Response, next: NextFunction): void => {
        const pagination = {
            limit: Math.min(
                positiveInteger(req.query.limit, defaultLimit),
                maxLimit,
            ),
            offset: nonNegativeInteger(req.query.offset),
        };
        const query = {
            ...req.query,
            limit: String(pagination.limit),
            offset: String(pagination.offset),
        };
        req.pagination = pagination;
        Object.defineProperty(req, "query", {
            configurable: true,
            value: query,
        });
        next();
    };
}
