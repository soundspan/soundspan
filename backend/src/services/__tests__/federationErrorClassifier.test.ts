import { z } from "zod";
import {
    FederationHttpError,
    FederationResponseError,
} from "../federationClient";
import { classifyFederationError } from "../federationErrorClassifier";

describe("federation outbound error classification", () => {
    it.each([
        ["ECONNREFUSED", "unreachable"],
        ["ENOTFOUND", "unreachable"],
        ["ETIMEDOUT", "unreachable"],
        ["EAI_AGAIN", "unreachable"],
        ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
        ["CERT_HAS_EXPIRED", "tls"],
        ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
    ] as const)("maps axios code %s to %s", (code, expected) => {
        const error = Object.assign(new Error(code), {
            isAxiosError: true,
            code,
        });

        expect(classifyFederationError(error)).toBe(expected);
    });

    it.each([401, 403])("maps peer HTTP %s to unauthorized", (status) => {
        expect(
            classifyFederationError(new FederationHttpError(status, false)),
        ).toBe("unauthorized");
    });

    it.each(["ECONNABORTED", "ECONNRESET", "ENETUNREACH"])(
        "maps wrapped transport code %s to unreachable",
        (transportCode) => {
            const error = new FederationHttpError(null, true, {
                transportCode,
            });

            expect(classifyFederationError(error)).toBe("unreachable");
        },
    );

    it("maps an old host's generic 400 response to peer_invalid", () => {
        expect(
            classifyFederationError(new FederationHttpError(400, false)),
        ).toBe("peer_invalid");
    });

    it.each([
        new FederationResponseError(),
        z
            .string()
            .parseAsync(42)
            .catch((error: unknown) => error),
    ])(
        "maps manifest and zod parsing failures to peer_invalid",
        async (value) => {
            expect(classifyFederationError(await value)).toBe("peer_invalid");
        },
    );
});
