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
    { name: "Home", href: "/" },
    { name: "Explore", href: "/explore" },
    { name: "Library", href: "/library" },
    { name: "Listen Together", href: "/listen-together" },
    { name: "Audiobooks", href: "/audiobooks" },
    { name: "Podcasts", href: "/podcasts" },
];

export const MOBILE_QUICK_LINKS: MobileQuickLinkItem[] = [
    { name: "Home", href: "/" },
    { name: "Explore", href: "/explore" },
    { name: "Listen Together", href: "/listen-together" },
];

/**
 * Executes hasMyHistoryLink.
 */
export function hasMyHistoryLink(
    links: ReadonlyArray<{ href: string }>
): boolean {
    return links.some((link) => link.href === "/my-history");
}
