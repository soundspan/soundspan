import type {
    ImportJob,
    PlaylistImportExecuteResponse,
    PlaylistImportPreviewResponse,
} from "../api";
import { IMPORT_PREVIEW_TIMEOUT_MS, type ApiClientConstructor } from "./core";

/** Add imports-domain operations to an API client base class. */
export function WithImports<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class ImportsApi extends Base {

    async previewPlaylistImport(
        url: string
    ): Promise<PlaylistImportPreviewResponse> {
        return this.request("/import/preview", {
            method: "POST",
            body: JSON.stringify({ url }),
            timeoutMs: IMPORT_PREVIEW_TIMEOUT_MS,
        });
    }

    async executePlaylistImport(input: {
        previewData: PlaylistImportPreviewResponse;
        name?: string;
    }): Promise<PlaylistImportExecuteResponse> {
        return this.post("/import/execute", input);
    }

    async previewM3UImport(
        content: string,
        name?: string
    ): Promise<PlaylistImportPreviewResponse> {
        return this.request("/import/m3u/preview", {
            method: "POST",
            body: JSON.stringify({ content, name }),
        });
    }

    async submitImportJob(url: string, name?: string) {
        return this.request<{
            deduped: boolean;
            job: ImportJob;
        }>("/import/jobs", {
            method: "POST",
            body: JSON.stringify({ url, name }),
        });
    }

    async listImportJobs() {
        return this.request<{ jobs: ImportJob[] }>("/import/jobs");
    }

    async getImportJob(jobId: string) {
        return this.request<{ job: ImportJob }>(`/import/jobs/${jobId}`);
    }

    async reconnectImportJob(url: string) {
        return this.request<{ job: ImportJob }>("/import/jobs/reconnect", {
            method: "POST",
            body: JSON.stringify({ url }),
        });
    }

    async cancelImportJob(jobId: string) {
        return this.request<{ job: ImportJob }>(`/import/jobs/${jobId}/cancel`, {
            method: "POST",
        });
    }
    }
    return ImportsApi;
}
