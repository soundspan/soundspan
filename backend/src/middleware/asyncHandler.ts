import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async Express-4 route handler so a rejected promise (or a thrown
 * error inside an async function, which is just a rejection) is forwarded to
 * `next(err)` — and from there to the shared `errorHandler` — instead of
 * hanging the request or surfacing only as an unhandled-rejection log line.
 *
 * Express 4 does not forward async rejections to error middleware on its
 * own; every handler has historically hand-rolled try/catch for this (see
 * the soundspan-api-endpoints skill). This wrapper exists so new/migrated
 * handlers don't have to (F1).
 *
 * Generic over the same P/ResBody/ReqBody/ReqQuery/Locals type parameters as
 * express.RequestHandler so a wrapped handler keeps its req.params/query/body
 * typing.
 */
export function asyncHandler<
    P = any,
    ResBody = any,
    ReqBody = any,
    ReqQuery = any,
    Locals extends Record<string, any> = Record<string, any>,
>(
    fn: (
        req: Request<P, ResBody, ReqBody, ReqQuery, Locals>,
        res: Response<ResBody, Locals>,
        next: NextFunction
    ) => Promise<unknown>
): RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals> {
    return (req, res, next) => {
        // The chain is returned (Express 4 ignores handler return values) so
        // direct-invocation test harnesses can `await` handler completion.
        return Promise.resolve(fn(req, res, next)).catch(next);
    };
}
