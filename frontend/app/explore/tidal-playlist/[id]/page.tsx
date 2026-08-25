"use client";

import { api } from "@/lib/api";
import { BrowseCollectionPage } from "@/features/explore/components/BrowseCollectionPage";

// Module-level so the fetcher keeps a stable identity across renders and the
// api method keeps its receiver.
const fetchPlaylist = (id: string) => api.getTidalBrowsePlaylist(id);

/**
 * Renders the TidalPlaylistDetailPage component.
 */
export default function TidalPlaylistDetailPage() {
    return (
        <BrowseCollectionPage kind="playlist" fetchCollection={fetchPlaylist} />
    );
}
