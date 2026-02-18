"use client";

import { useState, useEffect } from "react";
import { X, Download, Smartphone } from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function PWAInstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
    const [showPrompt, setShowPrompt] = useState(false);
    const [isIOS] = useState(() => {
        if (typeof window === "undefined") return false;
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as Record<string, unknown>).MSStream;
    });

    const isDismissedRecently = (): boolean => {
        const dismissedAt = localStorage.getItem("pwa-prompt-dismissed");
        if (!dismissedAt) return false;
        const dismissedTime = parseInt(dismissedAt, 10);
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        return Date.now() - dismissedTime < sevenDays;
    };

    useEffect(() => {
        // Check if already installed as PWA
        if (window.matchMedia("(display-mode: standalone)").matches) {
            return;
        }

        // Check if dismissed recently (within 7 days)
        if (isDismissedRecently()) {
            return;
        }

        // Listen for beforeinstallprompt (Chrome, Edge, etc.)
        const handleBeforeInstallPrompt = (e: Event) => {
            e.preventDefault();
            setDeferredPrompt(e as BeforeInstallPromptEvent);
            // Show prompt after a short delay
            setTimeout(() => {
                if (!isDismissedRecently()) {
                    setShowPrompt(true);
                }
            }, 3000);
        };

        window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

        // For iOS, show instructions after delay if on mobile
        if (isIOS) {
            setTimeout(() => {
                if (!isDismissedRecently()) {
                    setShowPrompt(true);
                }
            }, 5000);
        }

        return () => {
            window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
        };
    }, [isIOS]);

    const handleInstall = async () => {
        if (!deferredPrompt) return;

        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        
        if (outcome === "accepted") {
            setShowPrompt(false);
        }
        
        setDeferredPrompt(null);
    };

    const handleDismiss = () => {
        setShowPrompt(false);
        localStorage.setItem("pwa-prompt-dismissed", Date.now().toString());
    };

    if (!showPrompt) return null;

    return (
        <div className="fixed bottom-20 left-4 right-4 md:left-auto md:right-4 md:w-80 z-50 animate-slide-up">
            <div className="bg-[#1a1a1a] border border-[#333] rounded-xl p-4 shadow-2xl">
                <button
                    onClick={handleDismiss}
                    className="absolute top-2 right-2 p-1 text-white/50 hover:text-white/80 transition-colors"
                    aria-label="Dismiss"
                >
                    <X className="w-4 h-4" />
                </button>

                <div className="flex items-start gap-3">
                    <div className="p-2 bg-[#3b82f6]/20 rounded-lg">
                        <Smartphone className="w-6 h-6 text-[#3b82f6]" />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-white font-semibold text-sm mb-1">
                            Install {BRAND_NAME}
                        </h3>
                        {isIOS ? (
                            <p className="text-white/60 text-xs leading-relaxed">
                                Tap the <span className="text-white">Share</span> button, then{" "}
                                <span className="text-white">&quot;Add to Home Screen&quot;</span> for the best experience.
                            </p>
                        ) : (
                            <p className="text-white/60 text-xs leading-relaxed">
                                Add {BRAND_NAME} to your home screen for quick access and background audio.
                            </p>
                        )}
                    </div>
                </div>

                {!isIOS && deferredPrompt && (
                    <button
                        onClick={handleInstall}
                        className="w-full mt-3 py-2 px-4 bg-[#3b82f6] text-black font-semibold text-sm rounded-lg hover:bg-[#93c5fd] transition-colors flex items-center justify-center gap-2"
                    >
                        <Download className="w-4 h-4" />
                        Install App
                    </button>
                )}
            </div>
        </div>
    );
}
