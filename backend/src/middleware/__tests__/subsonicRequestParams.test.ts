import { type NextFunction, type Request, type Response } from "express";
import { mergeSubsonicBodyParamsIntoQuery } from "../subsonicRequestParams";

function runMiddleware(
    method: string,
    query: Record<string, unknown>,
    body: unknown,
): { next: jest.Mock; request: Request } {
    const request = { method, query, body } as unknown as Request;
    const next = jest.fn();

    mergeSubsonicBodyParamsIntoQuery(
        request,
        {} as Response,
        next as NextFunction,
    );

    return { next, request };
}

describe("mergeSubsonicBodyParamsIntoQuery", () => {
    it("merges supported body values without overriding URL query values", () => {
        const query = { client: "url-client" };
        const { next, request } = runMiddleware("POST", query, {
            client: "body-client",
            password: "secret",
            ids: ["one", "two"],
            count: 2,
            mixed: ["one", 2],
            nested: { value: "ignored" },
        });

        expect(request.query).toEqual({
            client: "url-client",
            password: "secret",
            ids: ["one", "two"],
        });
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("ignores prototype-related body keys", () => {
        const query: Record<string, unknown> = {};
        const originalPrototype = Object.getPrototypeOf(query);
        const body = Object.create(null) as Record<string, unknown>;
        Reflect.set(body, "__proto__", ["polluted"]);
        Reflect.set(body, "constructor", "polluted");
        Reflect.set(body, "prototype", "polluted");

        runMiddleware("POST", query, body);

        expect(Object.getPrototypeOf(query)).toBe(originalPrototype);
        expect(Object.hasOwn(query, "__proto__")).toBe(false);
        expect(Object.hasOwn(query, "constructor")).toBe(false);
        expect(Object.hasOwn(query, "prototype")).toBe(false);
    });

    it("leaves non-POST requests untouched", () => {
        const query = { client: "url-client" };
        const { next, request } = runMiddleware("GET", query, {
            password: "secret",
        });

        expect(request.query).toBe(query);
        expect(request.query).toEqual({ client: "url-client" });
        expect(next).toHaveBeenCalledTimes(1);
    });
});
