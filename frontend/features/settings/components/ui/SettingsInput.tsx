import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

interface SettingsInputProps {
    id?: string;
    type?: "text" | "password" | "url" | "number";
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
}

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
                    w-full bg-[#333] text-white text-sm
                    px-3 py-2 rounded-md
                    border-0 outline-none
                    focus:ring-2 focus:ring-white/20
                    placeholder:text-gray-500
                    transition-colors
                    hover:bg-[#404040] focus:bg-[#404040]
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

