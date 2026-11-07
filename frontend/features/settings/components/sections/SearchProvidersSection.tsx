"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { SettingsSection, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";

const PROVIDERS = ["lastfm", "deezer", "tidal", "youtube"] as const;
type SearchProvider = (typeof PROVIDERS)[number];

const DEFAULT_ORDER = "lastfm,deezer,tidal,youtube";
const DEFAULT_ENABLED = "lastfm,deezer";

const PROVIDER_INFO: Record<
    SearchProvider,
    { label: string; description: string }
> = {
    lastfm: {
        label: "Last.fm",
        description:
            "Artists and songs. Also corrects misspelled artist names.",
    },
    deezer: {
        label: "Deezer",
        description:
            "Artists and songs from Deezer's public catalog, including new releases. No account needed.",
    },
    tidal: {
        label: "TIDAL",
        description:
            "Artists and songs that play straight from TIDAL. Used only for users with a TIDAL session.",
    },
    youtube: {
        label: "YouTube Music",
        description:
            "Songs that play straight from YouTube Music, while the integration is enabled.",
    },
};

function isProvider(value: string): value is SearchProvider {
    return (PROVIDERS as readonly string[]).includes(value);
}

function splitList(value: string | undefined, fallback: string): string[] {
    return (value ?? fallback)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/** Stored order with unknown entries dropped and missing providers appended. */
export function parseProviderOrder(
    value: string | undefined,
): SearchProvider[] {
    const order = [
        ...new Set(splitList(value, DEFAULT_ORDER).filter(isProvider)),
    ];
    for (const provider of PROVIDERS) {
        if (!order.includes(provider)) order.push(provider);
    }
    return order;
}

interface SearchProvidersSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

/**
 * Admin card that orders and enables the catalog providers behind Search's
 * Discover results.
 */
export function SearchProvidersSection({
    settings,
    onUpdate,
}: SearchProvidersSectionProps) {
    const order = parseProviderOrder(settings.searchProviderOrder);
    const enabled = new Set(
        splitList(settings.searchProvidersEnabled, DEFAULT_ENABLED),
    );

    const move = (index: number, offset: -1 | 1) => {
        const next = [...order];
        const target = index + offset;
        [next[index], next[target]] = [next[target], next[index]];
        onUpdate({ searchProviderOrder: next.join(",") });
    };

    const toggle = (provider: SearchProvider, on: boolean) => {
        const next = order.filter((entry) =>
            entry === provider ? on : enabled.has(entry),
        );
        onUpdate({ searchProvidersEnabled: next.join(",") });
    };

    return (
        <SettingsSection
            id="search-providers"
            title="Search Providers"
            description="Where Search finds artists and songs that are not in the library. Enabled providers are searched together, and when two return the same artist or song, the one higher in this list is shown. Library results always come first."
        >
            <ol className="space-y-2">
                {order.map((provider, index) => {
                    const info = PROVIDER_INFO[provider];
                    const isEnabled = enabled.has(provider);
                    return (
                        <li
                            key={provider}
                            data-search-provider={provider}
                            className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.03] p-3"
                        >
                            <span className="w-5 text-center text-sm text-gray-400">
                                {index + 1}
                            </span>
                            <div className="flex flex-col">
                                <button
                                    type="button"
                                    aria-label={`Move ${info.label} up`}
                                    disabled={index === 0}
                                    onClick={() => move(index, -1)}
                                    className="rounded p-0.5 text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400"
                                >
                                    <ChevronUp className="h-4 w-4" />
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Move ${info.label} down`}
                                    disabled={index === order.length - 1}
                                    onClick={() => move(index, 1)}
                                    className="rounded p-0.5 text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400"
                                >
                                    <ChevronDown className="h-4 w-4" />
                                </button>
                            </div>
                            <div className="min-w-0 flex-1">
                                <p
                                    className={`text-sm font-medium ${
                                        isEnabled
                                            ? "text-white"
                                            : "text-gray-500"
                                    }`}
                                >
                                    {info.label}
                                </p>
                                <p className="text-xs text-gray-400">
                                    {info.description}
                                </p>
                            </div>
                            <SettingsToggle
                                id={`search-provider-${provider}`}
                                checked={isEnabled}
                                onChange={(on) => toggle(provider, on)}
                            />
                        </li>
                    );
                })}
            </ol>
        </SettingsSection>
    );
}
