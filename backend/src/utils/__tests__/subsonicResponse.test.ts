import { Response } from "express";
import {
    getResponseFormat,
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../subsonicResponse";

function createMockResponse(): {
    res: Response;
    status: jest.Mock;
    type: jest.Mock;
    send: jest.Mock;
    locals: Record<string, unknown>;
} {
    const status = jest.fn().mockReturnThis();
    const type = jest.fn().mockReturnThis();
    const send = jest.fn().mockReturnThis();
    const locals: Record<string, unknown> = {};
    const res = { status, type, send, locals } as unknown as Response;

    return { res, status, type, send, locals };
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
            expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(
                true,
            );
            expect(xml).toContain('<subsonic-response status="ok"');
            expect(xml).toContain("<ping/>");
        });

        it("sends JSONP response when callback is provided", () => {
            const { res, type, send } = createMockResponse();

            sendSubsonicSuccess(res, { ping: {} }, "jsonp", "cb");

            expect(type).toHaveBeenCalledWith("application/javascript");
            const jsonp = send.mock.calls[0][0] as string;
            expect(jsonp.startsWith("cb(")).toBe(true);
            expect(jsonp.endsWith(")")).toBe(true);
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
    });
});
