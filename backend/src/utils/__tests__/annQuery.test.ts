import { Prisma } from "@prisma/client";

// Capture every $queryRaw call as an inspectable descriptor and drive the
// batch result from $transaction — we assert on the SHAPE of the transaction
// batch (the F14 contract: probes set via set_config in the same tx as the
// ANN query), not on any incidental call order.
const mockQueryRaw = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../db", () => ({
    prisma: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

jest.mock("../../config", () => ({
    config: { ivfflatProbes: 12 },
}));

import { runAnnQuery } from "../annQuery";

type Descriptor = { __sqlArgs: unknown[] };

describe("runAnnQuery (F14 ivfflat.probes helper)", () => {
    beforeEach(() => {
        mockQueryRaw.mockReset();
        mockTransaction.mockReset();
        // Each $queryRaw call returns a descriptor of the args it was handed so
        // the test can inspect the exact statements placed in the tx batch.
        mockQueryRaw.mockImplementation((...args: unknown[]) => ({ __sqlArgs: args }));
    });

    it("runs the ANN query and set_config(probes) in one $transaction batch and returns the ANN rows", async () => {
        const annRows = [{ track_id: "t1" }, { track_id: "t2" }];
        mockTransaction.mockResolvedValueOnce([[{ set_config: "17" }], annRows]);

        const annQuery = Prisma.sql`
            SELECT te.track_id FROM track_embeddings te
            ORDER BY te.embedding <=> ${"[0,0,0]"}::vector LIMIT 5
        `;

        const result = await runAnnQuery<{ track_id: string }[]>(annQuery, 17);

        // Results come from the paired ANN query (the 2nd batch element).
        expect(result).toBe(annRows);

        // Exactly one transaction, carrying a two-statement batch.
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        const batch = mockTransaction.mock.calls[0][0] as Descriptor[];
        expect(batch).toHaveLength(2);

        // batch[0] is the set_config statement carrying the probes value N.
        const setConfigArgs = batch[0].__sqlArgs;
        const setConfigText = (setConfigArgs[0] as string[]).join("");
        expect(setConfigText).toContain("set_config");
        expect(setConfigText).toContain("ivfflat.probes");
        expect(setConfigArgs).toContain("17");

        // batch[1] is the exact ANN query we passed in — routed through, not rebuilt.
        expect(batch[1].__sqlArgs[0]).toBe(annQuery);
    });

    it("defaults the probes value to config.ivfflatProbes when the caller omits it", async () => {
        mockTransaction.mockResolvedValueOnce([[{ set_config: "12" }], []]);

        await runAnnQuery(Prisma.sql`SELECT 1`);

        const batch = mockTransaction.mock.calls[0][0] as Descriptor[];
        // config.ivfflatProbes is mocked to 12 above.
        expect(batch[0].__sqlArgs).toContain("12");
    });

    it("passes set_config the probes value as a string bind parameter (utility statements reject numeric binds)", async () => {
        mockTransaction.mockResolvedValueOnce([[{ set_config: "8" }], []]);

        await runAnnQuery(Prisma.sql`SELECT 1`, 8);

        const batch = mockTransaction.mock.calls[0][0] as Descriptor[];
        // The bound value is the STRING "8", never the number 8.
        expect(batch[0].__sqlArgs).toContain("8");
        expect(batch[0].__sqlArgs).not.toContain(8);
    });

    // ivfflat.probes' valid domain is 1..32768. Postgres does NOT error on an
    // out-of-range set_config — it emits only a server-log WARNING (invisible to
    // the app) and silently keeps the prior value, i.e. probes=1, resurrecting
    // the exact near-random-recall bug this helper fixes. So out-of-range input
    // must be clamped BEFORE it reaches set_config.
    it("clamps probes below 1 up to the domain floor (0 -> \"1\")", async () => {
        mockTransaction.mockResolvedValueOnce([[{ set_config: "1" }], []]);

        await runAnnQuery(Prisma.sql`SELECT 1`, 0);

        const batch = mockTransaction.mock.calls[0][0] as Descriptor[];
        expect(batch[0].__sqlArgs).toContain("1");
        expect(batch[0].__sqlArgs).not.toContain("0");
    });

    it("clamps probes above 32768 down to the domain ceiling", async () => {
        mockTransaction.mockResolvedValueOnce([[{ set_config: "32768" }], []]);

        await runAnnQuery(Prisma.sql`SELECT 1`, 999999999);

        const batch = mockTransaction.mock.calls[0][0] as Descriptor[];
        expect(batch[0].__sqlArgs).toContain("32768");
        expect(batch[0].__sqlArgs).not.toContain("999999999");
    });

    it("truncates fractional probes to an integer (set_config rejects non-integer text for an int GUC)", async () => {
        mockTransaction.mockResolvedValueOnce([[{ set_config: "7" }], []]);

        await runAnnQuery(Prisma.sql`SELECT 1`, 7.9);

        const batch = mockTransaction.mock.calls[0][0] as Descriptor[];
        expect(batch[0].__sqlArgs).toContain("7");
        expect(batch[0].__sqlArgs).not.toContain("7.9");
    });
});
