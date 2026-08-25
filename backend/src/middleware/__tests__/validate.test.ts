import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { validate } from "../validate";

function createResponse() {
    const response = {
        status: jest.fn(),
        json: jest.fn(),
    };
    response.status.mockReturnValue(response);
    response.json.mockReturnValue(response);
    return response;
}

describe("validate middleware", () => {
    const schema = {
        body: z.object({ name: z.string().trim().min(1) }),
        query: z.object({ limit: z.coerce.number().int().positive() }),
        params: z.object({ id: z.string().min(1) }),
    };

    it("parses all request boundaries and pins the Express 5 query", () => {
        const req = {
            body: { name: "  Alice  " },
            query: { limit: "7" },
            params: { id: "artist-1" },
        } as unknown as Request;
        const next = jest.fn();

        validate(schema)(req, createResponse() as unknown as Response, next);

        expect(req.valid).toEqual({
            body: { name: "Alice" },
            query: { limit: 7 },
            params: { id: "artist-1" },
        });
        expect(req.query).toEqual({ limit: 7 });
        expect(next).toHaveBeenCalledWith();
    });

    it("returns the canonical 400 response for an invalid body", () => {
        const req = {
            body: { name: "" },
            query: { limit: "7" },
            params: { id: "artist-1" },
        } as unknown as Request;
        const res = createResponse();
        const next = jest.fn() as NextFunction;

        validate(schema)(req, res as unknown as Response, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "Invalid request" });
        expect(next).not.toHaveBeenCalled();
    });
});
