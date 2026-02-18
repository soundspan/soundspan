import fs from "fs";
import path from "path";

describe("prisma connection resilience contract", () => {
    const unifiedEnrichmentSource = fs.readFileSync(
        path.resolve(__dirname, "../workers/unifiedEnrichment.ts"),
        "utf8",
    );
    const moodBucketSource = fs.readFileSync(
        path.resolve(__dirname, "../services/moodBucketService.ts"),
        "utf8",
    );
    const notificationServiceSource = fs.readFileSync(
        path.resolve(__dirname, "../services/notificationService.ts"),
        "utf8",
    );
    const organizeSinglesSource = fs.readFileSync(
        path.resolve(__dirname, "../workers/organizeSingles.ts"),
        "utf8",
    );
    const dbSource = fs.readFileSync(
        path.resolve(__dirname, "../utils/db.ts"),
        "utf8",
    );

    it("treats Prisma P2037 too-many-connections errors as transient in high-volume enrichment paths", () => {
        expect(unifiedEnrichmentSource).toContain("P2037");
        expect(moodBucketSource).toContain("P2037");
    });

    it("reuses the shared Prisma client in common worker/service paths", () => {
        expect(notificationServiceSource).not.toContain("new PrismaClient(");
        expect(notificationServiceSource).toContain(
            'import { prisma } from "../utils/db"',
        );

        expect(organizeSinglesSource).not.toContain("new PrismaClient(");
        expect(organizeSinglesSource).toContain(
            'import { prisma } from "../utils/db"',
        );
    });

    it("uses role-aware pool defaults so backend workers do not overrun postgres connections", () => {
        expect(dbSource).toContain("BACKEND_PROCESS_ROLE");
        expect(dbSource).toContain("DATABASE_POOL_SIZE");
        expect(dbSource).toContain("worker");
        expect(dbSource).toContain("api: 4");
        expect(dbSource).toContain("worker: 2");
        expect(dbSource).toContain("all: 6");
    });

    it("infers worker role from worker entrypoint when BACKEND_PROCESS_ROLE is unset", () => {
        expect(dbSource).toContain("process.argv");
        expect(dbSource).toContain("worker.js");
        expect(dbSource).toContain("role-inferred");
    });

    it("uses transactional enrichment progress reads to reduce connection churn under HA load", () => {
        expect(unifiedEnrichmentSource).toContain("getEnrichmentProgress.dbReads");
        expect(unifiedEnrichmentSource).toContain("prisma.$transaction([");
    });

    it("writes mood bucket assignments through a single transaction instead of fanout Promise.all", () => {
        expect(moodBucketSource).toContain("assignTrackToMoods.write");
        expect(moodBucketSource).toContain("prisma.$transaction([");
    });
});
