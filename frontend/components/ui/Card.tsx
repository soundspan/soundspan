import { HTMLAttributes, forwardRef, memo } from "react";
import { cn } from "@/utils/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
    variant?: "default" | "ai" | "metric";
    hover?: boolean;
}

const Card = memo(forwardRef<HTMLDivElement, CardProps>(
    (
        { className, variant = "default", hover = true, children, ...props },
        ref
    ) => {
        const baseStyles = "rounded-md p-3 transition-colors duration-200";

        const variantStyles = {
            default: cn(
                "bg-transparent",
                hover && "hover:bg-white/5"
            ),
            ai: cn(
                "bg-gradient-to-br from-surface-sunken to-surface-raised border border-surface-active",
                hover && "hover:border-yellow-500/30"
            ),
            metric: "bg-surface-raised border border-surface-active",
        };

        return (
            <div
                ref={ref}
                className={cn(baseStyles, variantStyles[variant], className)}
                {...props}
            >
                {children}
            </div>
        );
    }
));

Card.displayName = "Card";

export { Card };
