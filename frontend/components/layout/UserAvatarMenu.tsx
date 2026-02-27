"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Settings, LogOut, RefreshCw, Shield } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { useJobStatus } from "@/hooks/useJobStatus";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

export function UserAvatarMenu() {
    const { user, logout } = useAuth();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [isOpen, setIsOpen] = useState(false);
    const [imgError, setImgError] = useState(false);
    const [imgKey, setImgKey] = useState(0);
    const [scanJobId, setScanJobId] = useState<string | null>(null);
    const [lastScanTime, setLastScanTime] = useState(0);
    const menuRef = useRef<HTMLDivElement>(null);

    const { isPolling: isScanPolling } = useJobStatus(scanJobId, "scan", {
        onComplete: () => {
            queryClient.invalidateQueries({ queryKey: ["notifications"] });
            queryClient.invalidateQueries({ queryKey: ["enrichment-progress"] });
            setScanJobId(null);
        },
        onError: () => setScanJobId(null),
    });

    const displayName = user?.displayName || user?.username || "?";
    const initial = displayName.charAt(0).toUpperCase();

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (
                menuRef.current &&
                !menuRef.current.contains(e.target as Node)
            ) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [isOpen]);

    // Listen for profile picture changes from other components
    useEffect(() => {
        const handlePfpChange = () => {
            setImgError(false);
            setImgKey((k) => k + 1);
        };
        window.addEventListener("profile-picture-changed", handlePfpChange);
        return () => window.removeEventListener("profile-picture-changed", handlePfpChange);
    }, []);

    // Close on Escape
    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setIsOpen(false);
        };
        document.addEventListener("keydown", handleKey);
        return () => document.removeEventListener("keydown", handleKey);
    }, [isOpen]);

    const handleSync = async () => {
        if (isScanPolling) return;
        const now = Date.now();
        if (now - lastScanTime < 5000) return;

        try {
            setLastScanTime(now);
            const response = await api.scanLibrary();
            setScanJobId(response.jobId);
            queryClient.invalidateQueries({ queryKey: ["notifications"] });
        } catch (error) {
            sharedFrontendLogger.error("Failed to trigger library scan:", error);
        }
    };

    const handleLogout = async () => {
        setIsOpen(false);
        try {
            await logout();
            toast.success("Logged out successfully");
        } catch (error) {
            sharedFrontendLogger.error("Logout error:", error);
            toast.error("Failed to logout");
        }
    };

    return (
        <div ref={menuRef} className="relative">
            <button
                onClick={() => setIsOpen((v) => !v)}
                className={cn(
                    "w-9 h-9 rounded-full flex items-center justify-center overflow-hidden transition-all ring-2",
                    isOpen
                        ? "ring-white/40"
                        : "ring-transparent hover:ring-white/20"
                )}
                aria-label="User menu"
                aria-haspopup="true"
                aria-expanded={isOpen}
                title={displayName}
            >
                {user && !imgError ? (
                    <img
                        key={imgKey}
                        src={`${api.getProfilePictureUrl(user.id)}&_k=${imgKey}`}
                        alt={displayName}
                        className="w-full h-full object-cover"
                        onError={() => setImgError(true)}
                    />
                ) : (
                    <span className="w-full h-full bg-white/10 text-white/80 text-xs font-semibold flex items-center justify-center">
                        {initial}
                    </span>
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 top-full mt-2 w-48 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl shadow-black/40 py-1 z-[100]">
                    <div className="px-3 py-2 border-b border-white/10">
                        <p className="text-sm font-medium text-white truncate">
                            {displayName}
                        </p>
                    </div>
                    <button
                        onClick={handleSync}
                        disabled={isScanPolling}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-50"
                    >
                        <RefreshCw
                            className={cn(
                                "w-4 h-4",
                                isScanPolling && "animate-spin"
                            )}
                        />
                        {isScanPolling ? "Scanning..." : "Scan Library"}
                    </button>
                    <Link
                        href="/settings"
                        onClick={() => setIsOpen(false)}
                        className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                    >
                        <Settings className="w-4 h-4" />
                        Settings
                    </Link>
                    {user?.role === "admin" && (
                        <Link
                            href="/admin"
                            onClick={() => setIsOpen(false)}
                            className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                        >
                            <Shield className="w-4 h-4" />
                            Admin
                        </Link>
                    )}
                    <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                    >
                        <LogOut className="w-4 h-4" />
                        Log out
                    </button>
                </div>
            )}
        </div>
    );
}
