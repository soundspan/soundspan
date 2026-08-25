import {
    AcquisitionError,
    AcquisitionErrorType,
    cleanStuckDownloads,
    getQueue,
    getQueueCount,
    getRecentCompletedDownloads,
    isDownloadActive,
    lidarrService,
} from "../lidarr";
import { getSystemSettings } from "../../utils/systemSettings";
import { musicBrainzService } from "../musicbrainz";
import { stripAlbumEdition } from "../../utils/artistNormalization";
import { config as mockedConfig } from "../../config";
import { logger } from "../../utils/logger";
import { LidarrHttpClient, LidarrHttpError } from "../lidarr/lidarrHttpClient";

const mockLidarrClient = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
};

jest.mock("../lidarr/lidarrHttpClient", () => {
    const actual = jest.requireActual("../lidarr/lidarrHttpClient");
    return {
        ...actual,
        LidarrHttpClient: jest.fn(() => mockLidarrClient),
    };
});

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../utils/artistNormalization", () => ({
    ...jest.requireActual("../../utils/artistNormalization"),
    stripAlbumEdition: jest.fn((title: string) => title),
}));

jest.mock("../../config", () => ({
    config: {
        lidarr: undefined,
        music: {
            musicPath: "/music",
        },
    },
}));

jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: jest.fn(),
    },
}));

const mockLidarrHttpClient = LidarrHttpClient as jest.MockedClass<
    typeof LidarrHttpClient
>;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockMusicBrainzSearchArtist =
    musicBrainzService.searchArtist as jest.Mock;
const mockStripAlbumEdition = stripAlbumEdition as jest.Mock;

function createClientMock() {
    return {
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
    };
}

function primeServiceWithClient(client: ReturnType<typeof createClientMock>) {
    const svc = lidarrService as any;
    svc.client = client;
    svc.enabled = true;
    svc.initialized = true;
    svc.discoveryTagId = null;
    svc._indexerCountLogged = false;
}

export {
    AcquisitionError,
    AcquisitionErrorType,
    cleanStuckDownloads,
    getQueue,
    getQueueCount,
    getRecentCompletedDownloads,
    isDownloadActive,
    lidarrService,
    getSystemSettings,
    musicBrainzService,
    stripAlbumEdition,
    mockedConfig,
    logger,
    mockLidarrClient,
    mockLidarrHttpClient,
    mockGetSystemSettings,
    mockMusicBrainzSearchArtist,
    mockStripAlbumEdition,
    LidarrHttpError,
    createClientMock,
    primeServiceWithClient,
};
