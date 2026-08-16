import { z } from "zod";

const MIN_CHAPTER_COVERAGE = 0.85;
const CHAPTER_END_TOLERANCE_SECONDS = 2;
const MAX_SECTION_COUNT = 10_000;

const chapterPayloadSchema = z
    .array(
        z.looseObject({
            title: z.string().max(1000).optional(),
            start: z.number().finite(),
            end: z.number().finite(),
        }),
    )
    .max(MAX_SECTION_COUNT);

const audioFilePayloadSchema = z
    .array(
        z.looseObject({
            duration: z.number().finite().positive(),
            filename: z.string().max(4096).optional(),
            metadata: z
                .looseObject({ filename: z.string().max(4096).optional() })
                .optional(),
        }),
    )
    .max(MAX_SECTION_COUNT);

const sectionSchema = z.looseObject({
    index: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(1000),
    startSeconds: z.number().finite().nonnegative(),
});

const storedSectionsSchema = z.discriminatedUnion("kind", [
    z.looseObject({
        kind: z.literal("chapters"),
        sections: z.array(sectionSchema).min(1).max(MAX_SECTION_COUNT),
    }),
    z.looseObject({
        kind: z.literal("parts"),
        sections: z.array(sectionSchema).min(2).max(MAX_SECTION_COUNT),
    }),
    z.looseObject({
        kind: z.literal("none"),
        sections: z.array(sectionSchema).max(0),
    }),
]);

/** The source used to construct cached audiobook navigation. */
export type AudiobookSectionKind = "chapters" | "parts" | "none";

/** A validated seek target in seconds from the start of an audiobook stream. */
export type AudiobookSection = Readonly<{
    index: number;
    title: string;
    startSeconds: number;
}>;

/** Validated, cacheable audiobook navigation derived from an ABS payload. */
export type AudiobookSections = Readonly<{
    kind: AudiobookSectionKind;
    sections: ReadonlyArray<AudiobookSection>;
}>;

/** Untrusted Audiobookshelf values used to derive audiobook navigation. */
export type BuildSectionsInput = Readonly<{
    durationSeconds: unknown;
    chapters: unknown;
    audioFiles: unknown;
}>;

const EMPTY_SECTIONS: AudiobookSections = { kind: "none", sections: [] };

function hasValidChapterTimeline(
    chapters: z.infer<typeof chapterPayloadSchema>,
    durationSeconds: number,
): boolean {
    let previousStart = -1;
    let maximumEnd = 0;
    for (const chapter of chapters) {
        if (
            chapter.start < 0 ||
            chapter.end < chapter.start ||
            chapter.start <= previousStart ||
            chapter.end > durationSeconds + CHAPTER_END_TOLERANCE_SECONDS
        ) {
            return false;
        }
        previousStart = chapter.start;
        maximumEnd = Math.max(maximumEnd, chapter.end);
    }
    return maximumEnd / durationSeconds >= MIN_CHAPTER_COVERAGE;
}

function buildChapterSections(
    chapters: z.infer<typeof chapterPayloadSchema>,
): AudiobookSections {
    return {
        kind: "chapters",
        sections: chapters.map((chapter, index) => ({
            index,
            title: chapter.title?.trim() || `Chapter ${index + 1}`,
            startSeconds: chapter.start,
        })),
    };
}

function cleanPartTitle(filename: string | undefined, index: number): string {
    const basename = filename?.split(/[\\/]/).at(-1) ?? "";
    const withoutExtension = basename.replace(/\.[A-Za-z0-9]{1,10}$/, "");
    const withoutTrackNumber = withoutExtension.replace(
        /^\s*\d{1,4}(?:\s*[-_.\u2013\u2014)]\s*|\s+)/,
        "",
    );
    const cleaned = withoutTrackNumber
        .replace(/^[\s._\-\u2013\u2014]+/, "")
        .replace(/_+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned.slice(0, 1000).trim() || `Part ${index + 1}`;
}

function buildPartSections(
    audioFiles: z.infer<typeof audioFilePayloadSchema>,
): AudiobookSections {
    let startSeconds = 0;
    return {
        kind: "parts",
        sections: audioFiles.map((audioFile, index) => {
            const section = {
                index,
                title: cleanPartTitle(
                    audioFile.metadata?.filename ?? audioFile.filename,
                    index,
                ),
                startSeconds,
            };
            startSeconds += audioFile.duration;
            return section;
        }),
    };
}

function hasValidStoredOrder(
    sections: ReadonlyArray<AudiobookSection>,
): boolean {
    let previousStart = -1;
    for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index];
        if (
            !section ||
            section.index !== index ||
            section.startSeconds <= previousStart
        ) {
            return false;
        }
        previousStart = section.startSeconds;
    }
    return true;
}

/**
 * Build safe audiobook navigation from an untrusted expanded Audiobookshelf item.
 * Sparse or malformed chapters are rejected before multi-file parts are considered.
 */
export function buildSections(input: BuildSectionsInput): AudiobookSections {
    const duration = z
        .number()
        .finite()
        .positive()
        .safeParse(input.durationSeconds);
    const chapters = chapterPayloadSchema.safeParse(input.chapters);
    if (
        duration.success &&
        chapters.success &&
        chapters.data.length > 0 &&
        hasValidChapterTimeline(chapters.data, duration.data)
    ) {
        return buildChapterSections(chapters.data);
    }

    const audioFiles = audioFilePayloadSchema.safeParse(input.audioFiles);
    return audioFiles.success && audioFiles.data.length > 1
        ? buildPartSections(audioFiles.data)
        : EMPTY_SECTIONS;
}

/** Build sections only when the Audiobookshelf payload includes section data. */
export function buildSectionsWhenPresent(
    input: BuildSectionsInput,
): AudiobookSections | null {
    if (input.chapters === undefined && input.audioFiles === undefined) {
        return null;
    }
    return buildSections(input);
}

/** Parse cached section JSON, returning an honest-empty value for legacy or invalid rows. */
export function parseStoredSections(value: unknown): AudiobookSections {
    const parsed = storedSectionsSchema.safeParse(value);
    if (!parsed.success || !hasValidStoredOrder(parsed.data.sections)) {
        return EMPTY_SECTIONS;
    }
    return parsed.data;
}
