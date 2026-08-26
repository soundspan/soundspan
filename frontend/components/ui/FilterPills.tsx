import { memo, ReactNode } from "react";
import { cn } from "@/utils/cn";

export interface FilterPillOption<T extends string> {
    value: T;
    label: ReactNode;
    /** Overrides the default active styling (e.g. bg-ai text-white). */
    activeClassName?: string;
    title?: string;
}

export interface FilterPillsProps<T extends string> {
    options: ReadonlyArray<FilterPillOption<T>>;
    value: T;
    onChange: (value: T) => void;
    /** Style preset: md/sm filter pills, or a wrapped segmented compact toggle. */
    size?: "md" | "sm" | "segmented";
    className?: string;
    /** When set, stamps TV navigation data attributes on the group and pills. */
    tvSection?: string;
    "aria-label"?: string;
}

const SIZE_STYLES = {
    md: {
        group: "flex flex-wrap items-center gap-2",
        pill: "px-4 py-2 rounded-full text-sm font-semibold transition-all",
        active: "bg-white text-black",
        inactive:
            "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white border border-white/10",
    },
    sm: {
        group: "flex items-center gap-1",
        pill: "px-3 py-1.5 rounded-full text-xs font-medium transition-all",
        active: "bg-white text-black",
        inactive: "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10",
    },
    segmented: {
        group: "flex items-center gap-1 rounded-full bg-white/5 p-1",
        pill: "px-3 py-1.5 rounded-full text-xs font-medium transition-all",
        active: "bg-brand text-black",
        inactive: "text-gray-400 hover:text-white",
    },
} as const;

function FilterPillsInner<T extends string>({
    options,
    value,
    onChange,
    size = "md",
    className,
    tvSection,
    "aria-label": ariaLabel,
}: FilterPillsProps<T>) {
    const styles = SIZE_STYLES[size];
    return (
        <div
            role="group"
            aria-label={ariaLabel}
            data-tv-section={tvSection}
            className={cn(styles.group, className)}
        >
            {options.map((option, index) => {
                const isActive = option.value === value;
                const tvProps = tvSection
                    ? {
                          "data-tv-card": "",
                          "data-tv-card-index": index,
                          tabIndex: 0,
                      }
                    : {};
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={isActive}
                        title={option.title}
                        onClick={() => onChange(option.value)}
                        {...tvProps}
                        className={cn(
                            styles.pill,
                            isActive
                                ? (option.activeClassName ?? styles.active)
                                : styles.inactive,
                        )}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}

const FilterPills = memo(FilterPillsInner) as typeof FilterPillsInner;

export { FilterPills };
