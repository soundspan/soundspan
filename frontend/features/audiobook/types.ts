export interface AudiobookProgress {
    currentTime: number;
    progress: number;
    isFinished: boolean;
    lastPlayedAt: Date | string;
}

/** Source of validated audiobook navigation returned by the detail API. */
export type AudiobookSectionKind = "chapters" | "parts" | "none";

/** A seek target in seconds from the beginning of an audiobook stream. */
export interface AudiobookSection {
    index: number;
    title: string;
    startSeconds: number;
}

export interface AudiobookSeries {
    name: string;
    sequence: string;
}

export interface Audiobook {
    id: string;
    title: string;
    author: string;
    narrator?: string | null;
    description?: string | null;
    coverUrl: string | null;
    duration: number;
    libraryId?: string | null;
    publishedYear?: number | null;
    publisher?: string | null;
    genres?: string[];
    series?: AudiobookSeries | null;
    isbn?: string | null;
    asin?: string | null;
    language?: string | null;
    progress?: AudiobookProgress | null;
    sectionKind: AudiobookSectionKind;
    sections: AudiobookSection[];
    sectionsPlayable: boolean;
}

export interface AudiobookMetadata {
    narrator: string | null;
    genre: string | null;
    publishedYear: string | null;
    description: string | null;
}
