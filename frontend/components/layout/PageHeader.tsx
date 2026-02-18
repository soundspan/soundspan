import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

interface PageHeaderProps {
    title: string;
    subtitle: string;
    icon: LucideIcon;
    iconClassName?: string;
    titleClassName?: string;
    subtitleClassName?: string;
    className?: string;
    badge?: ReactNode;
    actions?: ReactNode;
}

export function PageHeader({
    title,
    subtitle,
    icon: Icon,
    iconClassName,
    titleClassName,
    subtitleClassName,
    className,
    badge,
    actions,
}: PageHeaderProps) {
    return (
        <div className={cn("mb-6", className)}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                        <Icon
                            className={cn(
                                "w-8 h-8 text-[#3b82f6] shrink-0",
                                iconClassName
                            )}
                        />
                        <h1
                            className={cn(
                                "text-3xl font-bold text-white",
                                titleClassName
                            )}
                        >
                            {title}
                        </h1>
                        {badge}
                    </div>
                    <p className={cn("text-white/60 mt-1", subtitleClassName)}>
                        {subtitle}
                    </p>
                </div>
                {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
            </div>
        </div>
    );
}
