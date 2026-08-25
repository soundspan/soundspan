import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { sendRouteError } from "../utils/routeErrorResponse";

export interface ValidationSchemas {
    body?: z.ZodType;
    query?: z.ZodType;
    params?: z.ZodType;
}

type ParsedSchemas<S extends ValidationSchemas> = {
    [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

export type ValidatedRequest<S extends ValidationSchemas> = Request & {
    valid: ParsedSchemas<S>;
};

function parseRequestPart(
    schema: z.ZodType | undefined,
    value: unknown,
): unknown {
    return schema ? schema.parse(value) : undefined;
}

/** Parses selected request boundaries and exposes their typed values on `req.valid`. */
export function validate<S extends ValidationSchemas>(
    schemas: S,
): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        try {
            const valid = {
                ...(schemas.body
                    ? { body: parseRequestPart(schemas.body, req.body) }
                    : {}),
                ...(schemas.query
                    ? { query: parseRequestPart(schemas.query, req.query) }
                    : {}),
                ...(schemas.params
                    ? { params: parseRequestPart(schemas.params, req.params) }
                    : {}),
            };
            req.valid = valid;
            if (valid.query !== undefined) {
                Object.defineProperty(req, "query", {
                    configurable: true,
                    value: valid.query,
                });
            }
            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                sendRouteError(res, 400, "Invalid request");
                return;
            }
            next(error);
        }
    };
}
