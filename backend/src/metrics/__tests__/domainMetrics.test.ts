import { Registry } from "prom-client";
import { createDomainMetrics } from "../domainMetrics";

describe("domain metrics", () => {
    it("registers bounded federation embedding page outcomes", async () => {
        const registry = new Registry();
        const metrics = createDomainMetrics(registry);

        metrics.federationEmbeddingPages.inc({ outcome: "stored" });
        metrics.federationEmbeddingPages.inc({
            outcome: "skipped_mismatch",
        });
        metrics.federationEmbeddingPages.inc({
            outcome: "skipped_legacy_strict",
        });

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            "# HELP soundspan_federation_embedding_pages_total",
        );
        expect(exposition).toContain('outcome="stored"} 1');
        expect(exposition).toContain('outcome="skipped_mismatch"} 1');
        expect(exposition).toContain('outcome="skipped_legacy_strict"} 1');
    });

    it("registers the bounded federation embedding export outcome", async () => {
        const registry = new Registry();
        const metrics = createDomainMetrics(registry);

        metrics.federationEmbeddingExports.inc({
            outcome: "suppressed_legacy_peer",
        });

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            "# HELP soundspan_federation_embedding_exports_total",
        );
        expect(exposition).toContain('outcome="suppressed_legacy_peer"} 1');
    });
});
