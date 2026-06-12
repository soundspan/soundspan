/**
 * Hook that determines whether TIDAL explore content should be shown.
 *
 * Queries the existing TIDAL streaming status endpoint and returns
 * `showTidalExplore: true` only when the service is enabled, available,
 * and the current user has authenticated TIDAL credentials.
 *
 * Defaults to `false` while loading to prevent premature browse queries.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useUserSettingsExplorePrefs } from "./useUserSettingsExplorePrefs";

interface TidalExploreState {
    /** True only when TIDAL is enabled, available, and authenticated. */
    showTidalExplore: boolean;
}

/**
 * Pure derivation exported for direct unit testing.
 */
export function deriveTidalExploreEnabled(status: {
    enabled: boolean;
    available: boolean;
    authenticated: boolean;
    isFetched: boolean;
    userSettingEnabled?: boolean;
}): boolean {
    if (!status.isFetched) return false;
    return status.enabled && status.available && status.authenticated && status.userSettingEnabled !== false;
}

/**
 * Fetches TIDAL streaming status and derives explore visibility.
 */
export function useTidalExploreEnabled(): TidalExploreState {
    const { data, isFetched } = useQuery<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
    }>({
        queryKey: ["tidal-streaming-status"],
        queryFn: () => api.getTidalStreamingStatus(),
        staleTime: 5 * 60 * 1000,
    });

    const { showTidalExplore: userSettingEnabled } = useUserSettingsExplorePrefs();

    return {
        showTidalExplore: deriveTidalExploreEnabled({
            enabled: data?.enabled ?? false,
            available: data?.available ?? false,
            authenticated: data?.authenticated ?? false,
            isFetched,
            userSettingEnabled,
        }),
    };
}
