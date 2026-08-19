const findMany = jest.fn();
jest.mock("../../../utils/db", () => ({ prisma: { track: { findMany } } }));

import {
    getQualityOutliers,
    isLossyAudioCodec,
    loadLossyAlbumQualityStats,
} from "../qualityOutliers";

describe("library health quality outliers", () => {
    beforeEach(() => jest.clearAllMocks());

    it.each([
        "mp3",
        "MPEG 1 Layer 3",
        "mpeg layer 3",
        "AAC",
        "m4a",
        "Opus",
        "Vorbis",
        "ogg",
        "WMA",
        "audio/mp4",
        "audio/aac",
        "audio/ogg",
        "audio/opus",
        "MACE 3:1",
        "MACE 6:1",
        "IMA 4:1",
        "uLaw 2:1",
        "QUALCOMM PureVoice",
        "AC-3",
        "MPEG-4/AAC",
        "MP4S",
        "ADPCM",
        "ALAW",
        "MULAW",
        "DVI_ADPCM",
        "GSM610",
        "MPEG_ADTS_AAC",
        "MPEG_LOAS",
        "RAW_AAC1",
        "DOLBY_AC3_SPDIF",
        "DVM",
        "RAW_SPORT",
        "ESST_AC3",
        "DRM",
        "DTS2",
        "MPEG",
        "MPEGLAYER3",
        "Windows Media Audio 9.2",
        "Windows Media Audio 10 Professional",
        "Windows Media Audio Voice",
        "Speex 1.x",
        "speex 1.2",
        "ALaw 2:1",
        "µLaw 2:1",
        "uLaw 2:1",
        "CCITT G.711 u-law",
        "CCITT G.711 A-law",
        "ALaw 2:1\t8-bit ITU-T G.711 A-law",
        "µLaw 2:1\t8-bit ITU-T G.711 µ-law\tApple Computer",
        "CCITT G.711 u-law 8-bit ITU-T G.711 µ-law",
        "CCITT G.711 A-law 8-bit ITU-T G.711 A-law",
        "MPEG/L1",
        "MPEG/L2",
        "MPEG/L3",
        "AC3",
        "AC3/BSID9",
        "AC3/BSID10",
        "EAC3",
        "AAC/MPEG2/LC",
        "AAC/MPEG2/LC/SBR",
        "AAC/MPEG2/MAIN",
        "AAC/MPEG2/SSR",
        "AAC/MPEG4/LC",
        "AAC/MPEG4/LC/SBR",
        "AAC/MPEG4/LTP",
        "AAC/MPEG4/MAIN",
        "AAC/MPEG4/SSR",
        "ATRAC/AT1",
        "DTS",
        "DTS/EXPRESS",
        "REAL/14_4",
        "REAL/28_8",
        "REAL/ATRC",
        "REAL/COOK",
        "REAL/SIPR",
        "QUICKTIME/QDMC",
        "QUICKTIME/QDM2",
    ])("classifies %s as lossy", (codec) => {
        expect(isLossyAudioCodec(codec)).toBe(true);
    });

    it.each([
        "FLAC",
        "ALAC",
        "PCM",
        "WAV",
        "AIFF",
        "APE",
        "WavPack",
        "Monkey's Audio",
        "DSD",
        "TAK",
        "TTA",
        "PCM S16 LE",
        "WAV-PCM",
        "IEEE_FLOAT",
        "Windows Media Audio 9 Lossless",
        "MACE",
        "MACE custom",
        "MACE 3:1+ALAC",
        "FLAC+Speex 1.x",
        "audio/flac",
        "DTS/LOSSLESS",
        "MLP",
        "REAL/RALF",
        "PCM/FLOAT/IEEE",
        "PCM/INT/BIG",
        "PCM/INT/LIT",
        "TRUEHD",
        "TTA1",
        "WAVPACK4",
        "MS/ACM",
        "QUICKTIME",
        "unknown-codec",
        "audio/mpeg",
        "",
        null,
    ])("does not classify %s as lossy", (codec) => {
        expect(isLossyAudioCodec(codec)).toBe(false);
    });

    it("classifies the bounded visible-track sample and ignores invalid durations", async () => {
        findMany.mockResolvedValueOnce([
            {
                mime: "MPEG 1 Layer 3",
                fileSize: 4_000_000,
                duration: 200,
                album: {
                    id: "al1",
                    title: "Album",
                    artist: { id: "a1", name: "Artist" },
                },
            },
            {
                mime: "FLAC",
                fileSize: 4_000_000,
                duration: 200,
                album: {
                    id: "lossless",
                    title: "Lossless Album",
                    artist: { id: "a1", name: "Artist" },
                },
            },
            {
                mime: "AAC",
                fileSize: 9_000_000,
                duration: 0,
                album: {
                    id: "al1",
                    title: "Album",
                    artist: { id: "a1", name: "Artist" },
                },
            },
        ]);

        const stats = await loadLossyAlbumQualityStats();
        const result = getQualityOutliers(stats, 192, {
            limit: 200,
            offset: -4,
        });

        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.not.objectContaining({ mime: expect.anything() }),
                select: expect.objectContaining({ mime: true }),
            }),
        );
        expect(result).toEqual(
            expect.objectContaining({
                limit: 100,
                offset: 0,
                total: 1,
                items: [expect.objectContaining({ averageBitrateKbps: 160 })],
            }),
        );
    });
});
