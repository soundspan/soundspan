import { cn } from "@/utils/cn";

interface NavCountBadgeProps {
    /** Preformatted count text, e.g. from formatCountBadge. */
    value: string;
    /** Screen-reader noun phrase read after the count, e.g. "pending requests". */
    label: string;
    className?: string;
}

/** Brand count bubble for navigation entries such as pending requests. */
export function NavCountBadge({ value, label, className }: NavCountBadgeProps) {
    return (
        <span
            className={cn(
                "flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-hover px-1 text-xs font-bold text-black",
                className,
            )}
        >
            {value}
            <span className="sr-only"> {label}</span>
        </span>
    );
}
