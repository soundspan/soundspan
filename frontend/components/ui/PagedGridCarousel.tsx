"use client";

import { useRef, useState, useEffect, useMemo, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

interface PagedGridCarouselProps<T> {
    items: T[];
    renderItem: (item: T, index: number) => ReactNode;
    keyExtractor: (item: T) => string;
    itemsPerPage?: number;
    columns?: number;
    rows?: number;
    gap?: string;
    className?: string;
}

export function PagedGridCarousel<T>({
    items,
    renderItem,
    keyExtractor,
    itemsPerPage = 6,
    columns = 3,
    rows = 2,
    gap = "gap-2",
    className,
}: PagedGridCarouselProps<T>) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const [currentPage, setCurrentPage] = useState(0);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    // Group items into pages
    const pages = useMemo(() => {
        const result: T[][] = [];
        for (let i = 0; i < items.length; i += itemsPerPage) {
            result.push(items.slice(i, i + itemsPerPage));
        }
        return result;
    }, [items, itemsPerPage]);

    // Check scroll state
    const checkScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 0);
        setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);

        // Update current page based on scroll position
        const pageWidth = el.clientWidth;
        const newPage = Math.round(el.scrollLeft / pageWidth);
        setCurrentPage(newPage);
    };

    useEffect(() => {
        checkScroll();
        const el = scrollRef.current;
        if (el) {
            el.addEventListener("scroll", checkScroll);
            window.addEventListener("resize", checkScroll);
        }
        return () => {
            if (el) el.removeEventListener("scroll", checkScroll);
            window.removeEventListener("resize", checkScroll);
        };
    }, [pages]);

    const scroll = (direction: "left" | "right") => {
        const el = scrollRef.current;
        if (!el) return;
        const scrollAmount = el.clientWidth;
        el.scrollBy({
            left: direction === "left" ? -scrollAmount : scrollAmount,
            behavior: "smooth",
        });
    };

    const goToPage = (pageIndex: number) => {
        const el = scrollRef.current;
        if (el) {
            el.scrollTo({
                left: pageIndex * el.clientWidth,
                behavior: "smooth",
            });
        }
    };

    if (items.length === 0) return null;

    return (
        <div className={cn("relative group/carousel", className)}>
            {/* Left Arrow (desktop only) */}
            {!isMobileOrTablet && canScrollLeft && (
                <button
                    onClick={() => scroll("left")}
                    className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/80  flex items-center justify-center opacity-0 group-hover/carousel:opacity-100 transition-opacity hover:bg-black hover:scale-105 border border-white/10 shadow-lg -translate-x-1/2"
                    aria-label="Scroll left"
                >
                    <ChevronLeft className="w-5 h-5 text-white" />
                </button>
            )}

            {/* Scrollable Container */}
            <div
                ref={scrollRef}
                className="flex overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory gap-3"
            >
                {pages.map((page, pageIndex) => (
                    <div
                        key={pageIndex}
                        className={cn(
                            "flex-shrink-0 snap-start w-full grid",
                            gap
                        )}
                        style={{
                            gridTemplateColumns: `repeat(${columns}, 1fr)`,
                            gridTemplateRows: `repeat(${rows}, 1fr)`,
                        }}
                    >
                        {page.map((item, itemIndex) => (
                            <div key={keyExtractor(item)}>
                                {renderItem(
                                    item,
                                    pageIndex * itemsPerPage + itemIndex
                                )}
                            </div>
                        ))}
                        {/* Fill empty slots */}
                        {page.length < itemsPerPage &&
                            Array.from({
                                length: itemsPerPage - page.length,
                            }).map((_, i) => <div key={`empty-${i}`} />)}
                    </div>
                ))}
            </div>

            {/* Right Arrow (desktop only) */}
            {!isMobileOrTablet && canScrollRight && (
                <button
                    onClick={() => scroll("right")}
                    className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/80  flex items-center justify-center opacity-0 group-hover/carousel:opacity-100 transition-opacity hover:bg-black hover:scale-105 border border-white/10 shadow-lg translate-x-1/2"
                    aria-label="Scroll right"
                >
                    <ChevronRight className="w-5 h-5 text-white" />
                </button>
            )}

            {/* Page indicators */}
            {pages.length > 1 && (
                <div className="flex justify-center gap-1.5 mt-3">
                    {pages.map((_, index) => (
                        <button
                            key={index}
                            onClick={() => goToPage(index)}
                            className={cn(
                                "w-1.5 h-1.5 rounded-full transition-colors",
                                index === currentPage
                                    ? "bg-white"
                                    : "bg-white/30 hover:bg-white/50"
                            )}
                            aria-label={`Go to page ${index + 1}`}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
