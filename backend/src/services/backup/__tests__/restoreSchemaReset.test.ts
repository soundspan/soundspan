import type { Client } from "pg";
import { resetApplicationSchema } from "../restoreSchemaReset";

describe("restore schema reset", () => {
    it("locks and checks User before reading or dropping schema objects", async () => {
        const queries: string[] = [];
        const client = {
            query: jest.fn(async (sql: string) => {
                queries.push(sql);
                if (sql.includes("count(*)")) return { rows: [{ count: "1" }] };
                return { rows: [] };
            }),
        } as unknown as Client;

        await expect(resetApplicationSchema(client)).rejects.toMatchObject({
            code: "RESTORE_UNAVAILABLE",
        });
        expect(queries[0]).toBe("BEGIN");
        expect(queries[1]).toContain('LOCK TABLE public."User"');
        expect(queries[2]).toContain('FROM public."User"');
        expect(queries.at(-1)).toBe("ROLLBACK");
        expect(queries.some((sql) => sql.includes("FROM pg_class"))).toBe(
            false,
        );
        expect(queries.some((sql) => sql.startsWith("DROP "))).toBe(false);
    });
});
