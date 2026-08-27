import { hasErrorCode, isForeignKeyViolationOn } from "../prismaErrors";

const AUDIOBOOK_PROGRESS_FK = "AudiobookProgress_audiobookshelfId_fkey";

describe("prisma error helpers", () => {
    it("matches a Prisma error code without assuming an Error instance", () => {
        expect(hasErrorCode({ code: "P2003" }, "P2003")).toBe(true);
        expect(hasErrorCode({ code: "P2002" }, "P2003")).toBe(false);
        expect(hasErrorCode(null, "P2003")).toBe(false);
        expect(hasErrorCode("P2003", "P2003")).toBe(false);
    });

    it("matches P2003 constraint and field metadata", () => {
        expect(
            isForeignKeyViolationOn(
                {
                    code: "P2003",
                    meta: { constraint: AUDIOBOOK_PROGRESS_FK },
                },
                AUDIOBOOK_PROGRESS_FK,
            ),
        ).toBe(true);
        expect(
            isForeignKeyViolationOn(
                {
                    code: "P2003",
                    meta: { constraint: { fields: ["audiobookshelfId"] } },
                },
                AUDIOBOOK_PROGRESS_FK,
            ),
        ).toBe(true);
        expect(
            isForeignKeyViolationOn(
                {
                    code: "P2003",
                    meta: { field_name: `${AUDIOBOOK_PROGRESS_FK} (index)` },
                },
                AUDIOBOOK_PROGRESS_FK,
            ),
        ).toBe(true);
    });

    it("matches the adapter-pg constraint index metadata", () => {
        expect(
            isForeignKeyViolationOn(
                {
                    code: "P2003",
                    meta: { constraint: { index: AUDIOBOOK_PROGRESS_FK } },
                },
                AUDIOBOOK_PROGRESS_FK,
            ),
        ).toBe(true);
        expect(
            isForeignKeyViolationOn(
                {
                    code: "P2003",
                    meta: {
                        constraint: {
                            index: "AudiobookProgress_userId_fkey",
                        },
                    },
                },
                AUDIOBOOK_PROGRESS_FK,
            ),
        ).toBe(false);
    });

    it("matches the nested adapter-pg constraint metadata", () => {
        const error = {
            code: "P2003",
            meta: {
                modelName: "AudiobookProgress",
                driverAdapterError: {
                    name: "DriverAdapterError",
                    cause: {
                        originalCode: "23503",
                        originalMessage:
                            'insert or update on table "AudiobookProgress" violates foreign key constraint "AudiobookProgress_audiobookshelfId_fkey"',
                        kind: "ForeignKeyConstraintViolation",
                        constraint: {
                            index: "AudiobookProgress_audiobookshelfId_fkey",
                        },
                    },
                },
            },
        };

        expect(isForeignKeyViolationOn(error, AUDIOBOOK_PROGRESS_FK)).toBe(
            true,
        );
        expect(
            isForeignKeyViolationOn(error, "AudiobookProgress_userId_fkey"),
        ).toBe(false);
    });

    it("rejects non-P2003 and differently identified constraints", () => {
        expect(
            isForeignKeyViolationOn(
                {
                    code: "P2002",
                    meta: { constraint: AUDIOBOOK_PROGRESS_FK },
                },
                AUDIOBOOK_PROGRESS_FK,
            ),
        ).toBe(false);
        expect(
            isForeignKeyViolationOn(
                {
                    code: "P2003",
                    meta: { constraint: "AudiobookProgress_userId_fkey" },
                },
                AUDIOBOOK_PROGRESS_FK,
            ),
        ).toBe(false);
    });

    it("rejects P2003 when metadata does not identify a constraint", () => {
        expect(
            isForeignKeyViolationOn({ code: "P2003" }, AUDIOBOOK_PROGRESS_FK),
        ).toBe(false);
        expect(
            isForeignKeyViolationOn(
                { code: "P2003", meta: { modelName: "AudiobookProgress" } },
                AUDIOBOOK_PROGRESS_FK,
            ),
        ).toBe(false);
    });
});
