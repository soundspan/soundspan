import { Tab } from "../types";
import { cn } from "@/utils/cn";

interface LibraryTabsProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

export function LibraryTabs({ activeTab, onTabChange }: LibraryTabsProps) {
  return (
    <div data-tv-section="library-tabs" className="flex gap-2 mb-4">
      <button
        data-tv-card
        data-tv-card-index={0}
        tabIndex={0}
        onClick={() => onTabChange("artists")}
        className={cn(
          "px-3 py-1.5 text-sm font-medium rounded-full transition-all",
          activeTab === "artists"
            ? "bg-white text-black"
            : "bg-white/10 text-white hover:bg-white/15"
        )}
      >
        Artists
      </button>
      <button
        data-tv-card
        data-tv-card-index={1}
        tabIndex={0}
        onClick={() => onTabChange("albums")}
        className={cn(
          "px-3 py-1.5 text-sm font-medium rounded-full transition-all",
          activeTab === "albums"
            ? "bg-white text-black"
            : "bg-white/10 text-white hover:bg-white/15"
        )}
      >
        Albums
      </button>
      <button
        data-tv-card
        data-tv-card-index={2}
        tabIndex={0}
        onClick={() => onTabChange("tracks")}
        className={cn(
          "px-3 py-1.5 text-sm font-medium rounded-full transition-all",
          activeTab === "tracks"
            ? "bg-white text-black"
            : "bg-white/10 text-white hover:bg-white/15"
        )}
      >
        Songs
      </button>
    </div>
  );
}
