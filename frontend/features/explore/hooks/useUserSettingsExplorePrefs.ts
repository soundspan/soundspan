/**
 * Lightweight hook that reads user settings relevant to the Explore page.
 *
 * Returns fail-closed defaults until usable settings data is available.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface ExplorePrefs {
    showYtMusicExplore: boolean;
    showTidalExplore: boolean;
}

/**
 * Fetches explore-relevant user settings with a 5-minute stale time.
 *
 * Defaults to `false` while the query is still loading so that
 * YT Music queries are not fired before the user's preference is known.
 * Once settings data is available, missing values fall back to the DB default.
 */
export function useUserSettingsExplorePrefs(): ExplorePrefs {
    const { data } = useQuery<{
        showYtMusicExplore?: boolean;
        showTidalExplore?: boolean;
    }>({
        queryKey: ["user-settings"],
        queryFn: () => api.getSettings(),
        staleTime: 5 * 60 * 1000,
    });

    if (data === undefined) {
        return { showYtMusicExplore: false, showTidalExplore: false };
    }

    return {
        showYtMusicExplore: data.showYtMusicExplore ?? true,
        showTidalExplore: data.showTidalExplore ?? true,
    };
}
