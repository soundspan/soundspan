import axios from "axios";
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

jest.mock("axios");

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

const mockAxiosCreate = axios.create as jest.Mock;
const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosDelete = axios.delete as jest.Mock;
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
    axios,
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
    mockAxiosCreate,
    mockAxiosGet,
    mockAxiosPost,
    mockAxiosDelete,
    mockGetSystemSettings,
    mockMusicBrainzSearchArtist,
    mockStripAlbumEdition,
    createClientMock,
    primeServiceWithClient,
};
