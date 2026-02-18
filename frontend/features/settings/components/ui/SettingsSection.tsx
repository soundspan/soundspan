import { ReactNode } from "react";

interface SettingsSectionProps {
    id: string;
    title: string;
    titleExtra?: ReactNode;
    description?: string;
    children: ReactNode;
    showSeparator?: boolean;
}

export function SettingsSection({
    id,
    title,
    titleExtra,
    description,
    children,
    showSeparator = true
}: SettingsSectionProps) {
    return (
        <section id={id} className="scroll-mt-24">
            <div className="mb-4">
                <div className="flex items-center gap-1.5">
                    <h2 className="text-base font-semibold text-white">{title}</h2>
                    {titleExtra}
                </div>
                {description && (
                    <p className="text-sm text-gray-400 mt-0.5">{description}</p>
                )}
            </div>
            
            <div className="space-y-1">
                {children}
            </div>
            
            {showSeparator && (
                <div className="border-t border-white/5 mt-6 mb-6" />
            )}
        </section>
    );
}

