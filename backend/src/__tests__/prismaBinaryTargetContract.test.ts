import fs from "fs";
import path from "path";

describe("prisma binary target contract", () => {
    it("pins debian-openssl-3.0.x for container runtimes", () => {
        const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
        const schema = fs.readFileSync(schemaPath, "utf8");

        expect(schema).toContain("generator client {");
        expect(schema).toContain('provider      = "prisma-client-js"');
        expect(schema).toContain('binaryTargets = ["native", "debian-openssl-3.0.x"]');
    });
});
