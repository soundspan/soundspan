export interface TvNavigationItem {
    name: string;
    href: string;
}

export const TV_NAVIGATION: TvNavigationItem[] = [
    { name: "Home", href: "/" },
    { name: "Search", href: "/search" },
    { name: "Library", href: "/library" },
    { name: "Audiobooks", href: "/audiobooks" },
    { name: "Podcasts", href: "/podcasts" },
    { name: "Discovery", href: "/discover" },
    { name: "Playlists", href: "/playlists" },
];

/**
 * Returns the TV navigation links, omitting the Discovery entry when the
 * discovery feature flag is disabled.
 */
export function getTvNavigation(discoveryEnabled: boolean): TvNavigationItem[] {
    if (discoveryEnabled) {
        return TV_NAVIGATION;
    }
    return TV_NAVIGATION.filter((item) => item.href !== "/discover");
}
