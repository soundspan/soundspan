"use client";

import { Card } from "@/components/ui/Card";
import type { AudiobookSection, AudiobookSectionKind } from "../types";

interface ChapterListProps {
    kind: AudiobookSectionKind;
    sections: AudiobookSection[];
    sectionsPlayable: boolean;
    onSeekToSection: (startTime: number) => void;
    formatTime: (seconds: number) => string;
}

/**
 * Renders the ChapterList component.
 */
export function ChapterList({
    kind,
    sections,
    sectionsPlayable,
    onSeekToSection,
    formatTime,
}: ChapterListProps) {
    if (kind === "none" || !sectionsPlayable || sections.length === 0) {
        return null;
    }

    const heading = kind === "parts" ? "Parts" : "Chapters";

    return (
        <section>
            <h2 className="text-2xl md:text-3xl font-bold mb-6">{heading}</h2>
            <Card className="p-6">
                <div className="space-y-2">
                    {sections.map((section) => (
                        <button
                            key={section.index}
                            onClick={() =>
                                onSeekToSection(section.startSeconds)
                            }
                            className="w-full text-left p-3 rounded-md hover:bg-surface-hover transition-colors group"
                        >
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-sm text-gray-400 mr-2">
                                        {section.index + 1}.
                                    </span>
                                    <span className="text-sm text-white group-hover:text-ai-hover">
                                        {section.title}
                                    </span>
                                </div>
                                <span className="text-xs text-gray-400">
                                    {formatTime(section.startSeconds)}
                                </span>
                            </div>
                        </button>
                    ))}
                </div>
            </Card>
        </section>
    );
}
