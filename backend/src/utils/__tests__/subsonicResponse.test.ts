import { Response } from "express";
import {
    getResponseFormat,
    isValidJsonpCallback,
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../subsonicResponse";

function createMockResponse(): {
    res: Response;
    status: jest.Mock;
    type: jest.Mock;
    set: jest.Mock;
    send: jest.Mock;
    locals: Record<string, unknown>;
} {
    const status = jest.fn().mockReturnThis();
    const type = jest.fn().mockReturnThis();
    const set = jest.fn().mockReturnThis();
    const send = jest.fn().mockReturnThis();
    const locals: Record<string, unknown> = {};
    const res = { status, type, set, send, locals } as unknown as Response;

    return { res, status, type, set, send, locals };
}

describe("subsonicResponse", () => {
    describe("getResponseFormat", () => {
        it("defaults to xml when format is missing", () => {
            expect(getResponseFormat({})).toBe("xml");
        });

        it("returns json when f=json", () => {
            expect(getResponseFormat({ f: "json" })).toBe("json");
        });

        it("returns jsonp when format=jsonp", () => {
            expect(getResponseFormat({ format: "jsonp" })).toBe("jsonp");
        });
    });

    describe("isValidJsonpCallback", () => {
        it.each(["cb", "my.callback_1", "$fn"])(
            "accepts the strict identifier %s",
            (callback) => {
                expect(isValidJsonpCallback(callback)).toBe(true);
            },
        );

        it.each(["alert(1)//", "a-b", "a b", "", "a".repeat(65), "<script>"])(
            "rejects the callback %s",
            (callback) => {
                expect(isValidJsonpCallback(callback)).toBe(false);
            },
        );
    });

    describe("sendSubsonicSuccess", () => {
        it("sends JSON response with Subsonic wrapper", () => {
            const { res, type, send, locals } = createMockResponse();

            sendSubsonicSuccess(res, { ping: {} }, "json");

            expect(type).toHaveBeenCalledWith("application/json");
            const payload = JSON.parse(send.mock.calls[0][0] as string) as {
                "subsonic-response": {
                    status: string;
                    version: string;
                    openSubsonic: boolean;
                    ping: Record<string, unknown>;
                };
            };
            expect(payload["subsonic-response"].status).toBe("ok");
            expect(payload["subsonic-response"].version).toBe("1.16.1");
            expect(payload["subsonic-response"].openSubsonic).toBe(true);
            expect(payload["subsonic-response"].ping).toEqual({});
            expect(locals.subsonicProtocolStatus).toBe("ok");
            expect(locals.subsonicErrorCode).toBeUndefined();
        });

        it("sends XML response with declaration", () => {
            const { res, type, send } = createMockResponse();

            sendSubsonicSuccess(res, { ping: {} }, "xml");

            expect(type).toHaveBeenCalledWith("application/xml");
            const xml = send.mock.calls[0][0] as string;
            expect(
                xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
            ).toBe(true);
            expect(xml).toContain('<subsonic-response status="ok"');
            expect(xml).toContain("<ping/>");
        });

        it.each(["cb", "my.callback_1", "$fn"])(
            "sends a nosniff JSONP response for valid callback %s",
            (callback) => {
                const { res, type, set, send } = createMockResponse();

                sendSubsonicSuccess(res, { ping: {} }, "jsonp", callback);

                expect(type).toHaveBeenCalledWith("application/javascript");
                expect(set).toHaveBeenCalledWith(
                    "X-Content-Type-Options",
                    "nosniff",
                );
                const jsonp = send.mock.calls[0][0] as string;
                expect(jsonp.startsWith(`${callback}(`)).toBe(true);
                expect(jsonp.endsWith(")")).toBe(true);
            },
        );

        it.each(["alert(1)//", "a-b", "a b", "", "a".repeat(65), "<script>"])(
            "falls back to JSON without reflecting callback %s",
            (callback) => {
                const { res, type, set, send } = createMockResponse();

                sendSubsonicSuccess(res, { ping: {} }, "jsonp", callback);

                expect(type).toHaveBeenCalledWith("application/json");
                expect(set).toHaveBeenCalledWith(
                    "X-Content-Type-Options",
                    "nosniff",
                );
                const body = send.mock.calls[0][0] as string;
                expect(() => JSON.parse(body)).not.toThrow();
                if (callback.length > 0) {
                    expect(body).not.toContain(callback);
                    expect(
                        JSON.stringify({
                            type: type.mock.calls,
                            set: set.mock.calls,
                        }),
                    ).not.toContain(callback);
                }
            },
        );

        it("falls back to nosniff JSON when the callback is missing", () => {
            const { res, type, set, send } = createMockResponse();

            sendSubsonicSuccess(res, { ping: {} }, "jsonp");

            expect(type).toHaveBeenCalledWith("application/json");
            expect(set).toHaveBeenCalledWith(
                "X-Content-Type-Options",
                "nosniff",
            );
            expect(() =>
                JSON.parse(send.mock.calls[0][0] as string),
            ).not.toThrow();
        });
    });

    describe("sendSubsonicError", () => {
        it("always sends HTTP 200 with JSON error payload", () => {
            const { res, status, type, send, locals } = createMockResponse();

            sendSubsonicError(
                res,
                SubsonicErrorCode.MISSING_PARAMETER,
                "Missing parameter",
                "json",
            );

            expect(status).toHaveBeenCalledWith(200);
            expect(type).toHaveBeenCalledWith("application/json");
            const payload = JSON.parse(send.mock.calls[0][0] as string) as {
                "subsonic-response": {
                    status: string;
                    error: { code: number; message: string };
                };
            };
            expect(payload["subsonic-response"].status).toBe("failed");
            expect(payload["subsonic-response"].error.code).toBe(
                SubsonicErrorCode.MISSING_PARAMETER,
            );
            expect(payload["subsonic-response"].error.message).toBe(
                "Missing parameter",
            );
            expect(locals.subsonicProtocolStatus).toBe("failed");
            expect(locals.subsonicErrorCode).toBe(
                SubsonicErrorCode.MISSING_PARAMETER,
            );
        });

        it("sends XML error payload", () => {
            const { res, status, type, send } = createMockResponse();

            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Not found",
                "xml",
            );

            expect(status).toHaveBeenCalledWith(200);
            expect(type).toHaveBeenCalledWith("application/xml");
            const xml = send.mock.calls[0][0] as string;
            expect(xml).toContain('<subsonic-response status="failed"');
            expect(xml).toContain('<error code="70" message="Not found"/>');
        });

        it("falls back to JSON for an invalid JSONP callback", () => {
            const callback = "alert(1)//";
            const { res, status, type, set, send } = createMockResponse();

            sendSubsonicError(
                res,
                SubsonicErrorCode.WRONG_CREDENTIALS,
                "Wrong credentials",
                "jsonp",
                callback,
            );

            expect(status).toHaveBeenCalledWith(200);
            expect(type).toHaveBeenCalledWith("application/json");
            expect(set).toHaveBeenCalledWith(
                "X-Content-Type-Options",
                "nosniff",
            );
            const body = send.mock.calls[0][0] as string;
            expect(() => JSON.parse(body)).not.toThrow();
            expect(body).not.toContain(callback);
            expect(
                JSON.stringify({ type: type.mock.calls, set: set.mock.calls }),
            ).not.toContain(callback);
        });

        it("wraps an error response for a valid JSONP callback", () => {
            const { res, status, type, set, send } = createMockResponse();

            sendSubsonicError(
                res,
                SubsonicErrorCode.WRONG_CREDENTIALS,
                "Wrong credentials",
                "jsonp",
                "client.callback",
            );

            expect(status).toHaveBeenCalledWith(200);
            expect(type).toHaveBeenCalledWith("application/javascript");
            expect(set).toHaveBeenCalledWith(
                "X-Content-Type-Options",
                "nosniff",
            );
            const body = send.mock.calls[0][0] as string;
            expect(body.startsWith("client.callback(")).toBe(true);
            expect(body.endsWith(")")).toBe(true);
        });
    });
});
