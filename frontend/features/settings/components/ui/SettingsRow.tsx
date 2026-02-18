import { ReactNode } from "react";

interface SettingsRowProps {
    label: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    htmlFor?: string;
    labelExtra?: ReactNode;
    align?: "center" | "start";
}

export function SettingsRow({
    label,
    description,
    children,
    htmlFor,
    labelExtra,
    align = "center",
}: SettingsRowProps) {
    return (
        <div
            className={`flex justify-between py-3 min-h-[56px] ${
                align === "start" ? "items-start" : "items-center"
            }`}
        >
            <div className="flex-1 pr-4">
                <div className="flex items-center gap-1.5">
                    <label
                        htmlFor={htmlFor}
                        className="text-sm text-white cursor-pointer"
                    >
                        {label}
                    </label>
                    {labelExtra}
                </div>
                {description && (
                    <p className="text-xs text-gray-500 mt-0.5">{description}</p>
                )}
            </div>
            <div className="shrink-0">
                {children}
            </div>
        </div>
    );
}
