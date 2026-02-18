import { ReactNode } from "react";
import Image from "next/image";

interface ConnectionCardProps {
    icon: string | ReactNode;
    title: string;
    description?: string;
    connected: boolean;
    connectedAs?: string;
    onConnect: () => void;
    onDisconnect: () => void;
    isLoading?: boolean;
}

export function ConnectionCard({
    icon,
    title,
    description,
    connected,
    connectedAs,
    onConnect,
    onDisconnect,
    isLoading
}: ConnectionCardProps) {
    return (
        <div className="flex items-center justify-between py-4 px-4 bg-[#1a1a1a] rounded-lg">
            <div className="flex items-center gap-3">
                {/* Icon */}
                <div className="w-10 h-10 rounded-full bg-[#282828] flex items-center justify-center overflow-hidden">
                    {typeof icon === "string" ? (
                        <Image 
                            src={icon} 
                            alt={title} 
                            width={24} 
                            height={24}
                            className="w-6 h-6"
                        />
                    ) : (
                        icon
                    )}
                </div>
                
                {/* Text */}
                <div>
                    <div className="text-sm font-medium text-white">{title}</div>
                    {connected && connectedAs ? (
                        <div className="text-xs text-gray-400">
                            Connected as <span className="text-white">{connectedAs}</span>
                        </div>
                    ) : description ? (
                        <div className="text-xs text-gray-500">{description}</div>
                    ) : null}
                </div>
            </div>
            
            {/* Action Button */}
            <button
                onClick={connected ? onDisconnect : onConnect}
                disabled={isLoading}
                className={`
                    px-4 py-1.5 text-sm font-medium rounded-full transition-colors
                    ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
                    ${connected 
                        ? 'bg-transparent border border-gray-600 text-white hover:border-white hover:scale-105' 
                        : 'bg-white text-black hover:scale-105'
                    }
                `}
            >
                {isLoading ? "..." : connected ? "Disconnect" : "Connect"}
            </button>
        </div>
    );
}

