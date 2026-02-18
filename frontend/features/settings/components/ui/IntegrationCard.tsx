"use client";

import { ReactNode } from "react";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";

interface IntegrationCardProps {
    icon: ReactNode;
    title: string;
    statusText: string;
    statusColor: "green" | "red" | "gray";
    connected: boolean;
    connectLabel?: string;
    disconnectLabel?: string;
    onConnect?: () => void;
    onDisconnect?: () => void;
    isLoading?: boolean;
    expanded: boolean;
    disabled?: boolean;
    disabledReason?: string;
    headerAction?: ReactNode;
    warning?: ReactNode;
    children?: ReactNode;
}

export function IntegrationCard({
    icon,
    title,
    statusText,
    statusColor,
    connected,
    connectLabel = "Connect",
    disconnectLabel = "Disconnect",
    onConnect,
    onDisconnect,
    isLoading = false,
    expanded,
    disabled = false,
    disabledReason,
    headerAction,
    warning,
    children,
}: IntegrationCardProps) {
    const statusIcon = isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
    ) : statusColor === "green" ? (
        <CheckCircle className="w-4 h-4 text-green-400" />
    ) : statusColor === "red" ? (
        <XCircle className="w-4 h-4 text-red-400" />
    ) : (
        <XCircle className="w-4 h-4 text-gray-500" />
    );

    return (
        <div
            className={`rounded-lg border border-white/[0.06] bg-[#1a1a1a] overflow-hidden transition-opacity ${
                disabled ? "opacity-50" : ""
            }`}
        >
            {/* Header row */}
            <div className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3">
                    {/* Icon */}
                    <div className="w-9 h-9 rounded-full bg-[#282828] flex items-center justify-center shrink-0">
                        {icon}
                    </div>

                    {/* Title + status */}
                    <div>
                        <div className="text-sm font-medium text-white">{title}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            {statusIcon}
                            <span className="text-xs text-gray-400">
                                {disabled && disabledReason
                                    ? disabledReason
                                    : statusText}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Action area */}
                {headerAction
                    ? headerAction
                    : !disabled && (connected ? onDisconnect : onConnect) && (
                        <button
                            onClick={connected ? onDisconnect : onConnect}
                            disabled={isLoading}
                            className={`
                                px-4 py-1.5 text-sm font-medium rounded-full transition-all shrink-0
                                ${isLoading ? "opacity-50 cursor-not-allowed" : ""}
                                ${connected
                                    ? "bg-transparent border border-gray-600 text-white hover:border-white"
                                    : "bg-white text-black hover:scale-105"
                                }
                            `}
                        >
                            {isLoading
                                ? "..."
                                : connected
                                  ? disconnectLabel
                                  : connectLabel}
                        </button>
                    )}
            </div>

            {/* Warning banner */}
            {warning && !disabled && (
                <div className="px-4 pb-2">
                    {warning}
                </div>
            )}

            {/* Collapsible body */}
            <div
                className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                style={{
                    gridTemplateRows: expanded && !disabled ? "1fr" : "0fr",
                }}
            >
                <div className="overflow-hidden min-h-0">
                    {children && (
                        <div className="px-4 pb-4 pt-1">
                            {children}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
