import { lidarrService } from "../lidarr";
import { simpleDownloadManager } from "../simpleDownloadManager";

jest.mock("../../config", () => ({
    config: {
        lidarr: undefined,
        music: { musicPath: "/music" },
    },
}));

jest.mock("../../utils/db", () => ({ prisma: {} }));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(async () => ({
        lidarrEnabled: true,
        lidarrUrl: "http://lidarr:8686",
        lidarrApiKey: "api-key",
    })),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn(() => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        })),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

function createClientMock() {
    return {
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
    };
}

describe("Lidarr blocklist retry semantics", () => {
    it("sends each caller's explicit skipRedownload intent through one client method", async () => {
        const client = createClientMock();
        const service = lidarrService as any;
        service.client = client;
        service.enabled = true;
        service.initialized = true;
        client.get
            .mockResolvedValueOnce({
                data: {
                    records: [
                        { id: 11, downloadId: "manual-next", title: "Manual" },
                    ],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    records: [
                        { id: 22, downloadId: "auto-next", title: "Automatic" },
                    ],
                },
            });
        client.delete.mockResolvedValue({ data: undefined });

        await lidarrService.blocklistAndRemove("manual-next", true);
        await (simpleDownloadManager as any).blocklistAndRetry("auto-next", 99);

        expect(client.delete).toHaveBeenNthCalledWith(1, "/api/v1/queue/11", {
            params: {
                removeFromClient: true,
                blocklist: true,
                skipRedownload: true,
            },
            timeoutMs: 10_000,
        });
        expect(client.delete).toHaveBeenNthCalledWith(2, "/api/v1/queue/22", {
            params: {
                removeFromClient: true,
                blocklist: true,
                skipRedownload: false,
            },
            timeoutMs: 10_000,
        });
    });
});
