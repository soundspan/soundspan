import axios from "axios";
import { z } from "zod";
import {
    FederationHttpError,
    FederationResponseError,
} from "./federationClient";

/** Stable outbound failure classes exposed by federation admin routes. */
export type FederationErrorClass =
    | "unreachable"
    | "tls"
    | "unauthorized"
    | "peer_invalid";

/** Failure classes persisted by recurring federation health probes. */
export type FederationHealthErrorClass = Extract<
    FederationErrorClass,
    "unreachable" | "tls" | "unauthorized" | "peer_invalid"
>;

const UNREACHABLE_CODES = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
]);
const TLS_CODES = new Set([
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
function errorCode(cause: unknown): string | undefined {
    if (cause instanceof FederationHttpError) return cause.transportCode;
    if (!axios.isAxiosError(cause)) return undefined;
    return cause.code;
}

function responseStatus(cause: unknown): number | undefined {
    if (cause instanceof FederationHttpError) return cause.status ?? undefined;
    return axios.isAxiosError(cause) ? cause.response?.status : undefined;
}

/** Classifies one outbound federation failure without side effects. */
export function classifyFederationError(cause: unknown): FederationErrorClass {
    const code = errorCode(cause);
    if (code && TLS_CODES.has(code)) return "tls";
    if (code && UNREACHABLE_CODES.has(code)) return "unreachable";
    const status = responseStatus(cause);
    if (status === 401 || status === 403) return "unauthorized";
    if (
        cause instanceof FederationResponseError ||
        cause instanceof z.ZodError
    ) {
        return "peer_invalid";
    }
    return "peer_invalid";
}

/** Classifies a federation health probe failure. */
export function classifyFederationHealthError(
    cause: unknown,
): FederationHealthErrorClass {
    const errorClass = classifyFederationError(cause);
    if (
        errorClass === "unreachable" ||
        errorClass === "tls" ||
        errorClass === "unauthorized"
    ) {
        return errorClass;
    }
    return "peer_invalid";
}
