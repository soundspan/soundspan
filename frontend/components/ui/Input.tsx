import { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/utils/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
    rightIcon?: ReactNode;
}

/**
 * Renders the Input component.
 */
export function Input({
    label,
    error,
    rightIcon,
    className,
    ...props
}: InputProps) {
    return (
        <div className="w-full">
            {label && (
                <label className="block text-sm font-medium mb-2 text-white">
                    {label}
                </label>
            )}
            <div className="relative">
                <input
                    className={cn(
                        "w-full bg-surface-hover border border-surface-active rounded-md px-4 py-2 text-white",
                        "placeholder:text-gray-400",
                        "focus:outline-none focus:ring-2 focus:ring-ai/50 focus:border-ai",
                        "transition-all duration-200",
                        error &&
                            "border-red-500/50 focus:ring-red-500/50 focus:border-red-500",
                        rightIcon && "pr-12",
                        className
                    )}
                    {...props}
                />
                {rightIcon && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white cursor-pointer transition-colors">
                        {rightIcon}
                    </div>
                )}
            </div>
            {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
        </div>
    );
}
