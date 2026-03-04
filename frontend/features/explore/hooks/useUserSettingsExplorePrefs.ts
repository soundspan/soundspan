/**
 * Lightweight hook that reads user settings relevant to the Explore page.
 *
 * Returns safe defaults while the settings query is still loading
 * so the Explore page never flashes empty sections.
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
 * Once the settings have loaded, falls back to `true` (the DB default).
 */
export function useUserSettingsExplorePrefs(): ExplorePrefs {
    const { data, isFetched } = useQuery<{ showYtMusicExplore?: boolean; showTidalExplore?: boolean }>({
        queryKey: ["user-settings"],
        queryFn: () => api.getSettings(),
        staleTime: 5 * 60 * 1000,
    });

    return {
        showYtMusicExplore: isFetched ? (data?.showYtMusicExplore ?? true) : false,
        showTidalExplore: isFetched ? (data?.showTidalExplore ?? true) : false,
    };
}
