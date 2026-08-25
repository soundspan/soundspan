"use client";

import { api } from "@/lib/api";
import { BrowseCollectionPage } from "@/features/explore/components/BrowseCollectionPage";

// Module-level so the fetcher keeps a stable identity across renders and the
// api method keeps its receiver.
const fetchMix = (id: string) => api.getTidalBrowseMix(id);

/**
 * Renders the TidalMixDetailPage component.
 */
export default function TidalMixDetailPage() {
    return <BrowseCollectionPage kind="mix" fetchCollection={fetchMix} />;
}
