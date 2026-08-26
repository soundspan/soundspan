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
    size?: "md" | "sm";
    className?: string;
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
} as const;

function FilterPillsInner<T extends string>({
    options,
    value,
    onChange,
    size = "md",
    className,
    "aria-label": ariaLabel,
}: FilterPillsProps<T>) {
    const styles = SIZE_STYLES[size];
    return (
        <div
            role="group"
            aria-label={ariaLabel}
            className={cn(styles.group, className)}
        >
            {options.map((option) => {
                const isActive = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={isActive}
                        title={option.title}
                        onClick={() => onChange(option.value)}
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
