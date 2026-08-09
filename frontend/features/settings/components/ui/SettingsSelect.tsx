import { ChevronDown } from "lucide-react";
import { SETTINGS_FIELD_FOCUS_RING } from "./settingsFieldStyles";

interface Option {
    value: string;
    label: string;
    description?: string;
}

interface SettingsSelectProps {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Option[];
    disabled?: boolean;
}

/**
 * Renders the SettingsSelect component.
 */
export function SettingsSelect({ id, value, onChange, options, disabled }: SettingsSelectProps) {
    return (
        <div className="relative">
            <select
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className={`
                    appearance-none bg-line-strong text-white text-sm
                    pl-3 pr-8 py-1.5 rounded-md
                    border-0 outline-none
                    ${SETTINGS_FIELD_FOCUS_RING}
                    cursor-pointer transition-colors
                    hover:bg-line-muted
                    ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                `}
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        </div>
    );
}
