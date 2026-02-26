export interface SidebarNavigationItem {
    name: string;
    href: string;
    badge?: string;
}

export interface MobileQuickLinkItem {
    name: string;
    href: string;
}

export const SIDEBAR_NAVIGATION: SidebarNavigationItem[] = [
    { name: "Library", href: "/library" },
    { name: "My Liked", href: "/playlist/my-liked" },
    { name: "Radio", href: "/radio" },
    { name: "Discovery", href: "/discover" },
    { name: "Listen Together", href: "/listen-together" },
    { name: "Audiobooks", href: "/audiobooks" },
    { name: "Podcasts", href: "/podcasts" },
    { name: "Browse", href: "/browse/playlists", badge: "Beta" },
];

export const MOBILE_QUICK_LINKS: MobileQuickLinkItem[] = [
    { name: "Discover", href: "/discover" },
    { name: "My Liked", href: "/playlist/my-liked" },
    { name: "Radio", href: "/radio" },
    { name: "Listen Together", href: "/listen-together" },
];

export function hasMyHistoryLink(
    links: ReadonlyArray<{ href: string }>
): boolean {
    return links.some((link) => link.href === "/my-history");
}
