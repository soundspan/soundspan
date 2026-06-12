import { type ReactNode } from "react";
import Image from "next/image";
import { Music } from "lucide-react";
import { cn } from "@/utils/cn";

interface CoverMosaicProps {
    /** Pre-proxied image URLs. */
    coverUrls: string[];
    /** Grid dimensions. @default "2x2" */
    layout?: "2x2" | "3x2";
    /** Custom empty-state node (0 URLs). Falls back to Music icon. */
    emptyState?: ReactNode;
    /** `<Image sizes>` hint. @default "96px" */
    imageSizes?: string;
    /** Outer container class. */
    className?: string;
    /** Apply opacity + grayscale. */
    greyed?: boolean;
    /** Scale on hover. */
    hoverScale?: boolean;
    /** Pulse skeleton loading state. */
    isLoading?: boolean;
    /** Show Music icon in unfilled cells. */
    showEmptyCellIcon?: boolean;
}

/**
 * Renders a mosaic grid of cover-art images.
 *
 * Callers must pass pre-proxied URLs — this component does NOT call
 * `api.getCoverArtUrl`.
 */
function CoverMosaic({
    coverUrls,
    layout = "2x2",
    emptyState,
    imageSizes = "96px",
    className,
    greyed = false,
    hoverScale = false,
    isLoading = false,
    showEmptyCellIcon = false,
}: CoverMosaicProps) {
    const cols = layout === "3x2" ? 3 : 2;
    const rows = layout === "3x2" ? 2 : 2;
    const totalCells = cols * rows;

    // 0 URLs → empty state
    if (coverUrls.length === 0) {
        if (isLoading) {
            return (
                <div
                    className={cn(
                        "w-full h-full",
                        layout === "3x2"
                            ? "grid grid-cols-3 grid-rows-2"
                            : "grid grid-cols-2 grid-rows-2",
                        className,
                    )}
                >
                    {Array.from({ length: totalCells }).map((_, i) => (
                        <div
                            key={`skeleton-${i}`}
                            className="animate-pulse bg-white/5"
                        />
                    ))}
                </div>
            );
        }
        return (
            <div
                className={cn(
                    "w-full h-full flex items-center justify-center",
                    className,
                )}
            >
                {emptyState ?? <Music className="w-10 h-10 text-gray-600" />}
            </div>
        );
    }

    // 1 URL in 2x2 → single full-bleed image
    if (coverUrls.length === 1 && layout === "2x2") {
        return (
            <div className={cn("relative w-full h-full", className)}>
                <Image
                    src={coverUrls[0]}
                    alt=""
                    fill
                    className={cn(
                        "object-cover",
                        greyed && "opacity-50 grayscale",
                        hoverScale && "group-hover:scale-105 transition-transform duration-300",
                    )}
                    sizes={imageSizes}
                    unoptimized
                />
            </div>
        );
    }

    // Grid rendering
    const gridCols = layout === "3x2" ? "grid-cols-3" : "grid-cols-2";
    const gridRows = layout === "3x2" ? "grid-rows-2" : "";
    const filledUrls = coverUrls.slice(0, totalCells);
    const emptyCellCount = Math.max(0, totalCells - filledUrls.length);

    return (
        <div
            className={cn(
                "grid w-full h-full",
                gridCols,
                gridRows,
                greyed && "opacity-50 grayscale",
                className,
            )}
        >
            {filledUrls.map((url, i) => (
                <div key={`${url}-${i}`} className="relative bg-[#181818]">
                    <Image
                        src={url}
                        alt=""
                        fill
                        className={cn(
                            "object-cover",
                            hoverScale && "group-hover:scale-105 transition-transform duration-300",
                        )}
                        sizes={imageSizes}
                        unoptimized
                    />
                </div>
            ))}
            {Array.from({ length: emptyCellCount }).map((_, i) => (
                <div
                    key={`empty-${i}`}
                    className="relative bg-[#282828] flex items-center justify-center"
                >
                    {showEmptyCellIcon && (
                        <Music className="w-5 h-5 text-gray-600" />
                    )}
                </div>
            ))}
        </div>
    );
}

export { CoverMosaic };
export type { CoverMosaicProps };
