export {};

const mockGetSystemSettings = jest.fn();
const mockAxiosCreate = jest.fn();

async function loadService(
    secretsDbOnly: boolean,
    audiobookshelf: { url: string; apiKey: string } | undefined,
) {
    jest.resetModules();
    jest.clearAllMocks();

    jest.doMock("../../config", () => ({
        config: { secretsDbOnly, audiobookshelf },
    }));
    jest.doMock("../../utils/systemSettings", () => ({
        getSystemSettings: (...args: unknown[]) =>
            mockGetSystemSettings(...args),
    }));
    jest.doMock("../../utils/db", () => ({
        prisma: { audiobook: { upsert: jest.fn() } },
    }));
    jest.doMock("../../utils/logger", () => ({
        logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }));
    jest.doMock("axios", () => ({
        __esModule: true,
        default: {
            create: (...args: unknown[]) => mockAxiosCreate(...args),
        },
    }));

    return (await import("../audiobookshelf")).audiobookshelfService;
}

function createClient() {
    return {
        get: jest.fn().mockResolvedValue({ data: { libraries: [] } }),
        patch: jest.fn(),
    };
}

describe("Audiobookshelf DB-only secrets policy", () => {
    beforeEach(() => {
        mockGetSystemSettings.mockReset();
        mockAxiosCreate.mockReset();
    });

    it("uses env config after a settings failure when DB-only mode is off", async () => {
        const client = createClient();
        mockGetSystemSettings.mockRejectedValue(new Error("settings down"));
        mockAxiosCreate.mockReturnValue(client);
        const service = await loadService(false, {
            url: "http://env-abs/",
            apiKey: "env-key-456",
        });

        await expect(service.getLibraries()).resolves.toEqual([]);
        expect(mockAxiosCreate).toHaveBeenCalledWith({
            baseURL: "http://env-abs",
            headers: { Authorization: "Bearer env-key-456" },
            timeout: 30000,
        });
    });

    it("surfaces an unreadable settings layer in DB-only mode", async () => {
        mockGetSystemSettings.mockRejectedValue(new Error("settings down"));
        const service = await loadService(true, {
            url: "http://env-abs/",
            apiKey: "env-key-456",
        });

        await expect(service.getLibraries()).rejects.toThrow(
            "SECRETS_DB_ONLY: system settings unreadable; Audiobookshelf credentials unavailable (no .env fallback)",
        );
        expect(mockAxiosCreate).not.toHaveBeenCalled();
    });

    it("uses database credentials in DB-only mode", async () => {
        const client = createClient();
        mockGetSystemSettings.mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://db-abs/",
            audiobookshelfApiKey: "db-key-123",
        });
        mockAxiosCreate.mockReturnValue(client);
        const service = await loadService(true, undefined);

        await expect(service.getLibraries()).resolves.toEqual([]);
        expect(mockAxiosCreate).toHaveBeenCalledWith({
            baseURL: "http://db-abs",
            headers: { Authorization: "Bearer db-key-123" },
            timeout: 30000,
        });
    });
});
