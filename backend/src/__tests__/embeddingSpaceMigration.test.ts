import fs from "fs";
import path from "path";

describe("embedding-space registry migration", () => {
    const migrationPath = path.resolve(
        __dirname,
        "../../prisma/migrations/20260816120000_add_embedding_space_registry/migration.sql",
    );
    const migration = fs.readFileSync(migrationPath, "utf8");

    it("seeds the canonical CLAP space with its fixed identity", () => {
        expect(migration).toContain("space_clap_music_audioset_v1");
        expect(migration).toContain(
            "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd",
        );
        expect(migration).toContain('"sampleRateHz": 48000');
        expect(migration).toContain(
            'CREATE UNIQUE INDEX "embedding_spaces_one_active_idx"',
        );
    });

    it("backfills before enforcing the space foreign key contract", () => {
        const backfill = migration.indexOf(
            'UPDATE "track_embeddings" SET "space_id"',
        );
        const notNull = migration.indexOf(
            'ALTER COLUMN "space_id" SET NOT NULL',
        );

        expect(backfill).toBeGreaterThan(-1);
        expect(notNull).toBeGreaterThan(backfill);
        expect(migration).toContain("ON DELETE RESTRICT");
    });

    it("removes the ambiguous model-version column", () => {
        expect(migration).toContain(
            'DROP INDEX "track_embeddings_model_version_idx"',
        );
        expect(migration).toContain('DROP COLUMN "model_version"');
    });
});
