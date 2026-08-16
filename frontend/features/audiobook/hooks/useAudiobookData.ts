"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useAudiobookQuery } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import { subscribeQueryEvent } from "@/lib/query-events";

/**
 * Executes useAudiobookData.
 */
export function useAudiobookData() {
    const params = useParams();
    const audiobookId = params.id as string;

    const {
        data: audiobook,
        isLoading,
        refetch,
    } = useAudiobookQuery(audiobookId);

    // Listen for audiobook-progress-updated event (fired when playback starts/updates)
    useEffect(() => {
        const unsubscribe = subscribeQueryEvent(
            "audiobook-progress-updated",
            () => {
                refetch();
            },
        );

        return unsubscribe;
    }, [refetch]);

    // Hero image for display (no token for proper caching)
    const heroImage = audiobook?.coverUrl
        ? api.getCoverArtUrl(audiobook.coverUrl, 1200)
        : null;
    // Separate URL with token for color extraction (CORS access for canvas)
    const colorExtractionImage = audiobook?.coverUrl
        ? api.getCoverArtUrl(audiobook.coverUrl, 300, true)
        : null;

    // Shape cached metadata for the hero without depending on live ABS files.
    const getMetadata = () => {
        if (!audiobook) return null;

        let narrator = audiobook.narrator;
        if (!narrator || narrator.trim() === "") {
            const desc = audiobook.description || "";
            const narratorMatch = desc.match(
                /(?:Read by|Narrated by):\s*(.+)/i,
            );
            if (narratorMatch) {
                narrator = narratorMatch[1].trim();
            }
        }

        return {
            narrator: narrator || null,
            genre: audiobook.genres?.[0] || null,
            publishedYear: audiobook.publishedYear?.toString() || null,
            description: audiobook.description || null,
        };
    };

    return {
        audiobookId,
        audiobook,
        isLoading,
        refetch,
        heroImage,
        colorExtractionImage,
        metadata: getMetadata(),
    };
}
