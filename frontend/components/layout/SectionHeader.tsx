import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { memo, type ReactNode } from "react";

interface SectionHeaderProps {
    title: ReactNode;
    /** Muted supporting line rendered under the title row. */
    description?: string;
    showAllHref?: string;
    rightAction?: ReactNode;
    badge?: ReactNode;
}

const SectionHeader = memo(function SectionHeader({
    title,
    description,
    showAllHref,
    rightAction,
    badge,
}: SectionHeaderProps) {
    return (
        <div className="mb-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <h2 className="text-2xl font-bold text-white">{title}</h2>
                    {badge && <Badge variant="ai">{badge}</Badge>}
                </div>
                {rightAction ? (
                    rightAction
                ) : showAllHref ? (
                    <Link
                        href={showAllHref}
                        className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors font-semibold group"
                    >
                        Show all
                        <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                    </Link>
                ) : null}
            </div>
            {description && (
                <p className="text-sm text-white/50 mt-1">{description}</p>
            )}
        </div>
    );
});

export { SectionHeader };
