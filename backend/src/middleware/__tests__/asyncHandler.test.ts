export {};

const mockLoggerError = jest.fn();

jest.mock("../../utils/logger", () => ({
    logger: {
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

describe("asyncHandler", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
    });

    /**
     * Mounts a fresh app with `errorHandler` as the last middleware, same as
     * index.ts does in production — this is the use case F1 exists to prove:
     * a route handler wrapped in asyncHandler that rejects must still reach
     * the shared errorHandler and get the same body shape a hand-rolled
     * try/catch + next(err) would produce.
     */
    async function buildApp(nodeEnv: "development" | "production") {
        jest.doMock("../../config", () => ({ config: { nodeEnv } }));

        const express = (await import("express")).default;
        const { asyncHandler } = await import("../asyncHandler");
        const { errorHandler } = await import("../errorHandler");

        const app = express();

        app.get(
            "/boom",
            asyncHandler(async () => {
                throw new Error("kaboom");
            })
        );

        app.get(
            "/rejects",
            asyncHandler(async () => {
                await Promise.reject(new Error("async rejection"));
            })
        );

        app.get(
            "/ok",
            asyncHandler(async (_req, res) => {
                res.status(200).json({ ok: true });
            })
        );

        app.use(errorHandler);
        return app;
    }

    it("forwards a thrown error from an async handler to errorHandler, which returns the prod-generic body", async () => {
        const request = (await import("supertest")).default;
        const app = await buildApp("production");

        const res = await request(app).get("/boom");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Internal server error" });
    });

    it("forwards a rejected promise from an async handler to errorHandler, which returns the prod-generic body", async () => {
        const request = (await import("supertest")).default;
        const app = await buildApp("production");

        const res = await request(app).get("/rejects");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Internal server error" });
    });

    it("forwards a rejected async handler to errorHandler, which returns message+stack in non-prod", async () => {
        const request = (await import("supertest")).default;
        const app = await buildApp("development");

        const res = await request(app).get("/boom");

        expect(res.status).toBe(500);
        expect(res.body.error).toBe("kaboom");
        expect(typeof res.body.stack).toBe("string");
    });

    it("does not invoke next(err) for a handler that resolves normally", async () => {
        const request = (await import("supertest")).default;
        const app = await buildApp("production");

        const res = await request(app).get("/ok");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(mockLoggerError).not.toHaveBeenCalled();
    });
});

// --- Type-level check (compile-time only; no runtime assertions) ---------
//
// asyncHandler must stay generic over the same P/ResBody/ReqBody/ReqQuery
// params as express.RequestHandler so a wrapped handler keeps its
// req.params/query/body typing under `tsc --noEmit`. This never runs, but if
// the generics leak to `any`, the property accesses below stop type-checking
// against their declared shapes and `tsc --noEmit` fails the suite.
import type { Request, Response } from "express";
import { asyncHandler } from "../asyncHandler";

interface ParamsShape {
    id: string;
}
interface QueryShape {
    limit?: string;
}
interface BodyShape {
    name: string;
}

function typeOnlyUsageNeverCalled() {
    return asyncHandler<ParamsShape, unknown, BodyShape, QueryShape>(
        async (
            req: Request<ParamsShape, unknown, BodyShape, QueryShape>,
            res: Response
        ) => {
            const id: string = req.params.id;
            const limit: string | undefined = req.query.limit;
            const name: string = req.body.name;
            res.status(200).json({ id, limit, name });
        }
    );
}
void typeOnlyUsageNeverCalled;
