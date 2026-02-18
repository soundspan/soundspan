export {};

const mockFindUnique = jest.fn();
const mockDecrypt = jest.fn();
const mockEncryptField = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("../db", () => ({
    prisma: {
        systemSettings: {
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
        },
    },
}));

jest.mock("../encryption", () => ({
    decrypt: (...args: unknown[]) => mockDecrypt(...args),
    encryptField: (...args: unknown[]) => mockEncryptField(...args),
    encrypt: jest.fn(),
}));

jest.mock("../logger", () => ({
    logger: {
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
    },
}));

function makeSettings(overrides: Record<string, unknown> = {}) {
    return {
        id: "default",
        lidarrApiKey: null,
        lidarrWebhookSecret: null,
        openaiApiKey: null,
        lastfmApiKey: null,
        fanartApiKey: null,
        audiobookshelfApiKey: null,
        soulseekPassword: null,
        ytMusicClientSecret: null,
        ...overrides,
    } as any;
}

describe("systemSettings utilities", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        mockDecrypt.mockImplementation((value: string) => `dec:${value}`);
        mockEncryptField.mockImplementation((value: unknown) => `enc:${value}`);
    });

    async function loadModule() {
        return import("../systemSettings");
    }

    it("returns null when settings are not present and does not cache null", async () => {
        mockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const { getSystemSettings } = await loadModule();

        await expect(getSystemSettings()).resolves.toBeNull();
        await expect(getSystemSettings()).resolves.toBeNull();

        expect(mockFindUnique).toHaveBeenCalledTimes(2);
        expect(mockFindUnique).toHaveBeenCalledWith({
            where: { id: "default" },
        });
    });

    it("decrypts sensitive fields and serves cached clones", async () => {
        mockFindUnique.mockResolvedValue(
            makeSettings({
                lidarrApiKey: "lidarr",
                lidarrWebhookSecret: "hook",
                openaiApiKey: "openai",
                lastfmApiKey: "lastfm",
                fanartApiKey: "fanart",
                audiobookshelfApiKey: "abs",
                soulseekPassword: "soulseek",
                ytMusicClientSecret: "yt",
            })
        );
        const { getSystemSettings } = await loadModule();

        const first = await getSystemSettings();
        const second = await getSystemSettings();

        expect(mockFindUnique).toHaveBeenCalledTimes(1);
        expect(first).not.toBe(second);
        expect(first.lidarrApiKey).toBe("dec:lidarr");
        expect(first.ytMusicClientSecret).toBe("dec:yt");
        expect(mockDecrypt).toHaveBeenCalledTimes(8);
    });

    it("bypasses cache when forceRefresh is true", async () => {
        mockFindUnique.mockResolvedValue(makeSettings({ lidarrApiKey: "secret" }));
        const { getSystemSettings } = await loadModule();

        await getSystemSettings();
        await getSystemSettings(true);

        expect(mockFindUnique).toHaveBeenCalledTimes(2);
    });

    it("logs one warning per field when decryption fails and returns null for that field", async () => {
        mockDecrypt.mockImplementation((value: string) => {
            if (value === "bad-value") {
                throw new Error("decrypt failed");
            }
            return `dec:${value}`;
        });
        mockFindUnique.mockResolvedValue(
            makeSettings({
                lidarrApiKey: "bad-value",
            })
        );
        const { getSystemSettings } = await loadModule();

        const first = await getSystemSettings(true);
        const second = await getSystemSettings(true);

        expect(first.lidarrApiKey).toBeNull();
        expect(second.lidarrApiKey).toBeNull();
        expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to decrypt lidarrApiKey")
        );
    });

    it("invalidates cache and fetches fresh settings", async () => {
        mockFindUnique
            .mockResolvedValueOnce(makeSettings({ lidarrApiKey: "first" }))
            .mockResolvedValueOnce(makeSettings({ lidarrApiKey: "second" }));
        const { getSystemSettings, invalidateSystemSettingsCache } =
            await loadModule();

        const cachedA = await getSystemSettings();
        const cachedB = await getSystemSettings();
        invalidateSystemSettingsCache();
        const refreshed = await getSystemSettings();

        expect(cachedA.lidarrApiKey).toBe("dec:first");
        expect(cachedB.lidarrApiKey).toBe("dec:first");
        expect(refreshed.lidarrApiKey).toBe("dec:second");
        expect(mockFindUnique).toHaveBeenCalledTimes(2);
    });

    it("re-exports encryptField from encryption", async () => {
        const { encryptField } = await loadModule();

        expect(encryptField("abc")).toBe("enc:abc");
        expect(mockEncryptField).toHaveBeenCalledWith("abc");
    });
});
