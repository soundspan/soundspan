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

    it("drops owned objects and routines in dependency-safe order", async () => {
        const queries: string[] = [];
        const scriptedRows = [
            { rows: [] },
            {
                rows: [
                    { kind: "sequence", name: 'seq"one', owner: "app" },
                    { kind: "view", name: "view_one", owner: "app" },
                    { kind: "table", name: "table_one", owner: "app" },
                    {
                        kind: "materialized view",
                        name: "mat_one",
                        owner: "app",
                    },
                ],
            },
            { rows: [{ name: "enum_one", owner: "app" }] },
            {
                rows: [
                    {
                        kind: "function",
                        name: 'fn"one',
                        arguments: "text, integer",
                        owner: "app",
                    },
                ],
            },
            { rows: [{ current_user: "app" }] },
        ];
        const client = {
            query: jest.fn(async (sql: string) => {
                queries.push(sql);
                return scriptedRows.shift() ?? { rows: [] };
            }),
        } as unknown as Client;

        await resetApplicationSchema(client, { allowExistingUsers: true });

        expect(queries[0]).toBe("BEGIN");
        expect(queries).not.toContain(
            'LOCK TABLE public."User" IN ACCESS EXCLUSIVE MODE',
        );
        const drops = queries.filter((sql) => sql.startsWith("DROP "));
        expect(drops).toEqual([
            'DROP TABLE IF EXISTS public."table_one" CASCADE',
            'DROP VIEW IF EXISTS public."view_one" CASCADE',
            'DROP MATERIALIZED VIEW IF EXISTS public."mat_one" CASCADE',
            'DROP SEQUENCE IF EXISTS public."seq""one" CASCADE',
            'DROP FUNCTION IF EXISTS public."fn""one"(text, integer) CASCADE',
            'DROP TYPE IF EXISTS public."enum_one" CASCADE',
        ]);
        expect(queries.at(-1)).toBe("COMMIT");
    });

    it("rejects objects owned by another database role", async () => {
        const results = [
            { rows: [] },
            {
                rows: [
                    { kind: "table", name: "foreign_table", owner: "other" },
                ],
            },
            { rows: [] },
            { rows: [] },
            { rows: [{ current_user: "app" }] },
        ];
        const client = {
            query: jest.fn(async () => results.shift() ?? { rows: [] }),
        } as unknown as Client;

        await expect(
            resetApplicationSchema(client, { allowExistingUsers: true }),
        ).rejects.toMatchObject({ code: "RESTORE_OBJECT_NOT_OWNED" });
        expect((client.query as jest.Mock).mock.calls.at(-1)?.[0]).toBe(
            "ROLLBACK",
        );
    });

    it("calls the commit observer at the reset transaction boundary", async () => {
        const committed = jest.fn();
        const results = [
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [{ current_user: "app" }] },
        ];
        const client = {
            query: jest.fn(async () => results.shift() ?? { rows: [] }),
        } as unknown as Client;

        await resetApplicationSchema(client, {
            allowExistingUsers: true,
            onCommitted: committed,
        });

        expect(committed).toHaveBeenCalledTimes(1);
        expect((client.query as jest.Mock).mock.calls.at(-1)?.[0]).toBe(
            "COMMIT",
        );
    });
});
