import type { Client } from "pg";
import { quoteIdent } from "./backupCatalog";
import { RestoreError } from "./backupErrors";

interface OwnedObject {
    kind: "table" | "view" | "materialized view" | "sequence" | "type";
    name: string;
    owner: string;
}

interface OwnedRoutine {
    kind: "function" | "procedure";
    name: string;
    arguments: string;
    owner: string;
}

async function readObjects(client: Client): Promise<OwnedObject[]> {
    const relations = await client.query<{
        kind: OwnedObject["kind"];
        name: string;
        owner: string;
    }>(`
        SELECT CASE c.relkind
                 WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                 WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                 WHEN 'S' THEN 'sequence'
               END AS kind,
               c.relname AS name, pg_get_userbyid(c.relowner) AS owner
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
           AND NOT EXISTS (
               SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_class'::regclass
                  AND d.objid = c.oid AND d.deptype = 'e'
           )
    `);
    const types = await client.query<{ name: string; owner: string }>(`
        SELECT t.typname AS name, pg_get_userbyid(t.typowner) AS owner
          FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND t.typtype IN ('e','c','d')
           AND NOT EXISTS (
               SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_type'::regclass
                  AND d.objid = t.oid AND d.deptype = 'e'
           )
           AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)
    `);
    return [
        ...relations.rows,
        ...types.rows.map((row) => ({ kind: "type" as const, ...row })),
    ];
}

async function readRoutines(client: Client): Promise<OwnedRoutine[]> {
    const result = await client.query<{
        kind: OwnedRoutine["kind"];
        name: string;
        arguments: string;
        owner: string;
    }>(`
        SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
               p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments,
               pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND NOT EXISTS (
               SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_proc'::regclass
                  AND d.objid = p.oid AND d.deptype = 'e'
           )
    `);
    return result.rows;
}

function assertOwnedByCurrentUser(
    objects: Array<OwnedObject | OwnedRoutine>,
    currentUser: string,
): void {
    const foreign = objects.filter((object) => object.owner !== currentUser);
    if (foreign.length === 0) return;
    const names = foreign
        .slice(0, 10)
        .map((object) => object.name)
        .join(", ");
    throw new RestoreError(
        "RESTORE_OBJECT_NOT_OWNED",
        `Application objects are owned by another role: ${names}`,
    );
}

function dropObjectSql(object: OwnedObject): string {
    const kind = object.kind.toUpperCase();
    return `DROP ${kind} IF EXISTS public.${quoteIdent(object.name)} CASCADE`;
}

function dropRoutineSql(routine: OwnedRoutine): string {
    return `DROP ${routine.kind.toUpperCase()} IF EXISTS public.${quoteIdent(
        routine.name,
    )}(${routine.arguments}) CASCADE`;
}

/** Drop only application-owned public objects while preserving extensions. */
export async function resetApplicationSchema(
    client: Client,
    options: {
        allowExistingUsers?: boolean;
        onCommitStarting?: () => void;
    } = {},
): Promise<void> {
    await client.query("BEGIN");
    try {
        if (!options.allowExistingUsers) {
            await client.query(
                'LOCK TABLE public."User" IN ACCESS EXCLUSIVE MODE',
            );
            const users = await client.query<{ count: string }>(
                'SELECT count(*)::text AS count FROM public."User"',
            );
            if (users.rows[0]?.count !== "0") {
                throw new RestoreError(
                    "RESTORE_UNAVAILABLE",
                    "Restore is unavailable after a user has been created",
                );
            }
        }
        const objects = await readObjects(client);
        const routines = await readRoutines(client);
        const userResult = await client.query<{ current_user: string }>(
            "SELECT current_user",
        );
        const currentUser = userResult.rows[0]?.current_user;
        if (!currentUser) {
            throw new Error("Could not resolve current database user");
        }
        assertOwnedByCurrentUser([...objects, ...routines], currentUser);
        const order: OwnedObject["kind"][] = [
            "table",
            "view",
            "materialized view",
            "sequence",
        ];
        for (const kind of order) {
            for (const object of objects.filter(
                (entry) => entry.kind === kind,
            )) {
                await client.query(dropObjectSql(object));
            }
        }
        for (const routine of routines)
            await client.query(dropRoutineSql(routine));
        for (const object of objects.filter((entry) => entry.kind === "type")) {
            await client.query(dropObjectSql(object));
        }
        options.onCommitStarting?.();
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
}
