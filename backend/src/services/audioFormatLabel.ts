import * as path from "path";

const UNKNOWN_AUDIO_FORMAT_LABEL = "audio/mpeg";
const AUDIO_FORMAT_LABEL_BY_EXTENSION = new Map([
    [".mp3", "MP3"],
    [".flac", "FLAC"],
    [".m4a", "M4A"],
    [".aac", "AAC"],
    [".ogg", "OGG"],
    [".opus", "Opus"],
    [".wav", "WAV"],
    [".wma", "WMA"],
    [".ape", "APE"],
    [".wv", "WavPack"],
]);

function normalizeFormatLabel(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

/** Derives the scanner's persisted audio-format label from parsed metadata and path. */
export function deriveAudioFormatLabel(
    format: { codec?: string; container?: string },
    filePath: string,
): string {
    return (
        normalizeFormatLabel(format.codec) ??
        normalizeFormatLabel(format.container) ??
        AUDIO_FORMAT_LABEL_BY_EXTENSION.get(
            path.extname(filePath).toLowerCase(),
        ) ??
        UNKNOWN_AUDIO_FORMAT_LABEL
    );
}
