import { Response } from "express";

export const SUBSONIC_API_VERSION = "1.16.1";
export const SUBSONIC_SERVER_TYPE = "soundspan";
export const SUBSONIC_SERVER_VERSION = "1.0.0";

export enum SubsonicErrorCode {
    GENERIC = 0,
    MISSING_PARAMETER = 10,
    CLIENT_VERSION_MISMATCH = 20,
    SERVER_VERSION_MISMATCH = 30,
    WRONG_CREDENTIALS = 40,
    TOKEN_AUTH_NOT_SUPPORTED = 41,
    API_KEY_AUTH_NOT_SUPPORTED = 42,
    MULTIPLE_AUTH_MECHANISMS = 43,
    INVALID_API_KEY = 44,
    NOT_AUTHORIZED = 50,
    TRIAL_EXPIRED = 60,
    NOT_FOUND = 70,
}

export type ResponseFormat = "xml" | "json" | "jsonp";

interface SubsonicQuery {
    format?: unknown;
    f?: unknown;
}

export type SubsonicPayload = Record<string, unknown>;

interface SubsonicResponseBody {
    "subsonic-response": {
        status: "ok" | "failed";
        version: string;
        type: string;
        serverVersion: string;
        openSubsonic: boolean;
    } & SubsonicPayload;
}

/**
 * Resolves the response format from Subsonic query params, defaulting to XML.
 */
export function getResponseFormat(query: SubsonicQuery): ResponseFormat {
    const formatParam = typeof query.format === "string" ? query.format : undefined;
    const fParam = typeof query.f === "string" ? query.f : undefined;
    const raw = (formatParam ?? fParam ?? "xml").toLowerCase();

    if (raw === "json") return "json";
    if (raw === "jsonp") return "jsonp";
    return "xml";
}

/**
 * Sends a protocol-level successful Subsonic response in the requested format.
 */
export function sendSubsonicSuccess(
    res: Response,
    data: SubsonicPayload,
    format: ResponseFormat,
    callback?: string,
): void {
    if (res.locals) {
        res.locals.subsonicProtocolStatus = "ok";
        delete res.locals.subsonicErrorCode;
        delete res.locals.subsonicErrorMessage;
    }

    const response = buildResponseWrapper("ok", data);
    sendResponse(res, response, format, callback);
}

/**
 * Sends a protocol-level failed Subsonic response while preserving HTTP 200 semantics.
 */
export function sendSubsonicError(
    res: Response,
    code: SubsonicErrorCode,
    message: string,
    format: ResponseFormat,
    callback?: string,
): void {
    if (res.locals) {
        res.locals.subsonicProtocolStatus = "failed";
        res.locals.subsonicErrorCode = code;
        res.locals.subsonicErrorMessage = message;
    }

    const response = buildResponseWrapper("failed", {
        error: {
            code,
            message,
        },
    });

    // Subsonic clients expect protocol-level errors in body with HTTP 200.
    res.status(200);
    sendResponse(res, response, format, callback);
}

function buildResponseWrapper(
    status: "ok" | "failed",
    data: SubsonicPayload,
): SubsonicResponseBody {
    return {
        "subsonic-response": {
            status,
            version: SUBSONIC_API_VERSION,
            type: SUBSONIC_SERVER_TYPE,
            serverVersion: SUBSONIC_SERVER_VERSION,
            openSubsonic: true,
            ...data,
        },
    };
}

function sendResponse(
    res: Response,
    response: SubsonicResponseBody,
    format: ResponseFormat,
    callback?: string,
): void {
    if (format === "json" || format === "jsonp") {
        const json = JSON.stringify(response);
        if (format === "jsonp" && callback) {
            res.type("application/javascript");
            res.send(`${callback}(${json})`);
            return;
        }
        res.type("application/json");
        res.send(json);
        return;
    }

    const xmlBody = objectToXml(
        response["subsonic-response"],
        "subsonic-response",
    );
    res.type("application/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n${xmlBody}`);
}

function objectToXml(value: unknown, rootName?: string): string {
    if (value === null || value === undefined) {
        return "";
    }

    if (Array.isArray(value)) {
        return value.map((entry) => objectToXml(entry, rootName)).join("");
    }

    if (!isObject(value)) {
        return escapeXml(toStringValue(value));
    }

    const attributes: string[] = [];
    const children: string[] = [];

    for (const [key, entry] of Object.entries(value)) {
        if (entry === null || entry === undefined) {
            continue;
        }

        if (Array.isArray(entry)) {
            for (const item of entry) {
                children.push(objectToXml(item, key));
            }
            continue;
        }

        if (isObject(entry)) {
            children.push(objectToXml(entry, key));
            continue;
        }

        attributes.push(`${key}="${escapeXml(toStringValue(entry))}"`);
    }

    if (!rootName) {
        return children.join("");
    }

    const attrs = attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
    if (children.length === 0) {
        return `<${rootName}${attrs}/>`;
    }

    return `<${rootName}${attrs}>${children.join("")}</${rootName}>`;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringValue(value: unknown): string {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === "object" && value !== null) {
        return JSON.stringify(value);
    }
    return String(value);
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
