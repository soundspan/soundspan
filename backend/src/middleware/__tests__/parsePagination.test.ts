import type { Request, Response } from "express";
import { parsePagination } from "../parsePagination";

function run(query: Record<string, unknown>, options = {}) {
    const req = { query } as unknown as Request;
    const next = jest.fn();
    parsePagination(options)(req, {} as Response, next);
    return { req, next };
}

describe("parsePagination middleware", () => {
    it("uses bounded defaults", () => {
        const { req, next } = run({});

        expect(req.pagination).toEqual({ limit: 100, offset: 0 });
        expect(next).toHaveBeenCalledWith();
    });

    it("clamps an over-limit value and a negative offset", () => {
        const { req } = run(
            { limit: "999", offset: "-8" },
            { defaultLimit: 25, maxLimit: 50 },
        );

        expect(req.pagination).toEqual({ limit: 50, offset: 0 });
    });

    it("pins normalized values on req.query", () => {
        const { req } = run({ limit: "nope", offset: "4" });

        expect(req.query).toEqual({ limit: "100", offset: "4" });
    });
});
