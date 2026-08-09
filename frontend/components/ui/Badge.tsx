import { HTMLAttributes, forwardRef, memo } from "react";
import { cn } from "@/utils/cn";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "success" | "warning" | "error" | "info" | "ai" | "default";
}

const Badge = memo(forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = "default", children, ...props }, ref) => {
    const variantStyles = {
      success: "bg-green-500/10 text-green-500 ring-green-500/20",
      warning: "bg-brand/10 text-brand ring-brand/20",
      error: "bg-red-500/10 text-red-500 ring-red-500/20",
      info: "bg-blue-500/10 text-blue-500 ring-blue-500/20",
      ai: "bg-ai/10 text-ai ring-ai/20",
      default: "bg-surface-hover text-gray-400 ring-line",
    };

    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ring-1",
          variantStyles[variant],
          className
        )}
        {...props}
      >
        {children}
      </span>
    );
  }
));

Badge.displayName = "Badge";

export { Badge };
