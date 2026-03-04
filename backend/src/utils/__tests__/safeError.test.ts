import { safeError } from "../errors";

describe("safeError", () => {
    function createMockRes() {
        const jsonFn = jest.fn();
        const statusFn = jest.fn(() => ({ json: jsonFn }));
        return { res: { status: statusFn }, statusFn, jsonFn };
    }

    function createMockLogger() {
        return { error: jest.fn() };
    }

    it("returns generic 500 message by default", () => {
        const { res, statusFn, jsonFn } = createMockRes();
        const log = createMockLogger();

        safeError(res, new Error("secret DB password leak"), log, "Test context");

        expect(statusFn).toHaveBeenCalledWith(500);
        expect(jsonFn).toHaveBeenCalledWith({ error: "Internal server error" });
    });

    it("logs full error message server-side", () => {
        const { res } = createMockRes();
        const log = createMockLogger();

        safeError(res, new Error("detailed internal info"), log, "My handler");

        expect(log.error).toHaveBeenCalledWith(
            "My handler:",
            "detailed internal info",
        );
    });

    it("never exposes the original error message to the client", () => {
        const { res, jsonFn } = createMockRes();
        const log = createMockLogger();

        safeError(res, new Error("SQL syntax error near 'DROP TABLE'"), log, "Query");

        const responseBody = jsonFn.mock.calls[0][0];
        expect(responseBody.error).not.toContain("SQL");
        expect(responseBody.error).not.toContain("DROP TABLE");
        expect(responseBody.error).toBe("Internal server error");
    });

    it("handles non-Error objects", () => {
        const { res, jsonFn } = createMockRes();
        const log = createMockLogger();

        safeError(res, "string error", log, "Handler");

        expect(jsonFn).toHaveBeenCalledWith({ error: "Internal server error" });
        expect(log.error).toHaveBeenCalledWith("Handler:", "string error");
    });

    it("handles null/undefined errors", () => {
        const { res, jsonFn } = createMockRes();
        const log = createMockLogger();

        safeError(res, null, log, "Handler");

        expect(jsonFn).toHaveBeenCalledWith({ error: "Internal server error" });
    });

    it("allows custom status code", () => {
        const { res, statusFn, jsonFn } = createMockRes();
        const log = createMockLogger();

        safeError(res, new Error("bad gateway"), log, "Proxy", 502);

        expect(statusFn).toHaveBeenCalledWith(502);
        expect(jsonFn).toHaveBeenCalledWith({ error: "Internal server error" });
    });
});
