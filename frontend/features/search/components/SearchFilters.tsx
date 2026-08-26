import { Download, Network } from "lucide-react";
import {
    FilterPills,
    type FilterPillOption,
} from "@/components/ui/FilterPills";
import { FilterTab } from "../types";

interface SearchFiltersProps {
    filterTab: FilterTab;
    onFilterChange: (tab: FilterTab) => void;
    soulseekEnabled: boolean;
    federationEnabled: boolean;
    hasSearched: boolean;
}

/** Builds the filter options for the enabled search sources. */
function buildFilterOptions(
    soulseekEnabled: boolean,
    federationEnabled: boolean,
): FilterPillOption<FilterTab>[] {
    const options: FilterPillOption<FilterTab>[] = [
        { value: "all", label: "All" },
        { value: "library", label: "My Library" },
        { value: "discover", label: "Discover" },
        { value: "podcasts", label: "Podcasts" },
    ];
    if (federationEnabled) {
        options.push({
            value: "peers",
            label: (
                <span className="flex items-center gap-2">
                    <Network className="h-4 w-4" />
                    Peers
                </span>
            ),
            activeClassName: "bg-brand text-black",
        });
    }
    if (soulseekEnabled) {
        options.push({
            value: "soulseek",
            label: (
                <span className="flex items-center gap-2">
                    <Download className="w-4 h-4" />
                    Soulseek
                </span>
            ),
            activeClassName: "bg-brand text-black",
        });
    }
    return options;
}

/**
 * Renders the SearchFilters component.
 */
export function SearchFilters({
    filterTab,
    onFilterChange,
    soulseekEnabled,
    federationEnabled,
    hasSearched,
}: SearchFiltersProps) {
    if (!hasSearched) {
        return null;
    }

    return (
        <FilterPills
            options={buildFilterOptions(soulseekEnabled, federationEnabled)}
            value={filterTab}
            onChange={onFilterChange}
            className="mb-8"
            tvSection="search-filters"
            aria-label="Search result filter"
        />
    );
}
