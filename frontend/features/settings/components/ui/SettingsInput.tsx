import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { SETTINGS_FIELD_FOCUS_RING } from "./settingsFieldStyles";

interface SettingsInputProps {
    id?: string;
    type?: "text" | "password" | "url" | "number" | "email";
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
}

/**
 * Renders the SettingsInput component.
 */
export function SettingsInput({ 
    id, 
    type = "text", 
    value, 
    onChange, 
    placeholder,
    disabled,
    className = ""
}: SettingsInputProps) {
    const [showPassword, setShowPassword] = useState(false);
    const isPassword = type === "password";
    
    return (
        <div className={`relative ${className}`}>
            <input
                id={id}
                type={isPassword && showPassword ? "text" : type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                className={`
                    w-full bg-line-strong text-white text-sm
                    px-3 py-2 rounded-md
                    border-0 outline-none
                    ${SETTINGS_FIELD_FOCUS_RING}
                    placeholder:text-gray-400
                    transition-colors
                    hover:bg-line-muted focus:bg-line-muted
                    ${isPassword ? 'pr-10' : ''}
                    ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                `}
            />
            {isPassword && (
                <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition-colors"
                >
                    {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                    ) : (
                        <Eye className="w-4 h-4" />
                    )}
                </button>
            )}
        </div>
    );
}
