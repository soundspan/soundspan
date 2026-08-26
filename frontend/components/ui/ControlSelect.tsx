import { forwardRef, memo, SelectHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

export type ControlSelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * The standard rounded-pill select for browse-page control rows.
 * One styling for every page so sort/pagination/genre dropdowns match.
 */
const ControlSelect = memo(
    forwardRef<HTMLSelectElement, ControlSelectProps>(
        ({ className, children, ...props }, ref) => (
            <select
                ref={ref}
                className={cn(
                    "px-4 py-2 bg-surface-hover border border-white/10 rounded-full text-white text-sm focus:outline-none focus:border-brand focus:bg-[#252525] transition-all disabled:opacity-50 disabled:cursor-not-allowed [&>option]:bg-surface-hover [&>option]:text-white",
                    className,
                )}
                {...props}
            >
                {children}
            </select>
        ),
    ),
);

ControlSelect.displayName = "ControlSelect";

export { ControlSelect };
