"use client";

import { useEffect } from "react";
import {
    createMigratingStorageKey,
    readMigratingStorageItem,
} from "@/lib/storage-migration";

type BrowserServiceWorkerRegistration = globalThis.ServiceWorkerRegistration;

const IS_PLAYING_KEY = createMigratingStorageKey("is_playing");
const WAITING_WORKER_CHECK_INTERVAL_MS = 2000;

function isPlaybackActive(): boolean {
    return readMigratingStorageItem(IS_PLAYING_KEY) === "true";
}

function maybeActivateWaitingWorker(
    registration: BrowserServiceWorkerRegistration,
    context: string,
    deferredLogRef: { value: boolean }
) {
    const waitingWorker = registration.waiting;
    if (!waitingWorker) {
        deferredLogRef.value = false;
        return;
    }

    if (isPlaybackActive()) {
        if (!deferredLogRef.value) {
            deferredLogRef.value = true;
            console.log(
                `[SW] Update ready but deferred while playback is active (${context})`
            );
        }
        return;
    }

    deferredLogRef.value = false;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

export function ServiceWorkerRegistration() {
    useEffect(() => {
        if (typeof window === "undefined") return;
        if (!("serviceWorker" in navigator)) return;

        let disposed = false;
        let waitingWorkerIntervalId: number | null = null;
        let registrationRef: BrowserServiceWorkerRegistration | null = null;
        let updateFoundHandler: (() => void) | null = null;
        const deferredLogRef = { value: false };

        const handleControllerChange = () => {
            console.log("[SW] Service worker controller updated");
        };

        const handleVisibilityChange = () => {
            if (document.hidden) return;
            if (!registrationRef) return;
            maybeActivateWaitingWorker(
                registrationRef,
                "visibilitychange",
                deferredLogRef
            );
        };

        navigator.serviceWorker.addEventListener(
            "controllerchange",
            handleControllerChange
        );
        document.addEventListener("visibilitychange", handleVisibilityChange);

        navigator.serviceWorker
            .register("/sw.js")
            .then((registration) => {
                if (disposed) return;
                registrationRef = registration;

                updateFoundHandler = () => {
                    const installingWorker = registration.installing;
                    if (!installingWorker) return;

                    const handleInstallingStateChange = () => {
                        if (installingWorker.state !== "installed") return;

                        installingWorker.removeEventListener(
                            "statechange",
                            handleInstallingStateChange
                        );

                        if (!navigator.serviceWorker.controller) return;

                        maybeActivateWaitingWorker(
                            registration,
                            "updatefound",
                            deferredLogRef
                        );
                    };

                    installingWorker.addEventListener(
                        "statechange",
                        handleInstallingStateChange
                    );
                };

                registration.addEventListener("updatefound", updateFoundHandler);

                console.log("[SW] Service Worker registered:", registration.scope);
                maybeActivateWaitingWorker(
                    registration,
                    "register",
                    deferredLogRef
                );

                waitingWorkerIntervalId = window.setInterval(() => {
                    if (!registrationRef) return;
                    maybeActivateWaitingWorker(
                        registrationRef,
                        "poll",
                        deferredLogRef
                    );
                }, WAITING_WORKER_CHECK_INTERVAL_MS);
            })
            .catch((error) => {
                console.error("[SW] Service Worker registration failed:", error);
            });

        return () => {
            disposed = true;

            if (waitingWorkerIntervalId !== null) {
                window.clearInterval(waitingWorkerIntervalId);
                waitingWorkerIntervalId = null;
            }

            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange
            );
            navigator.serviceWorker.removeEventListener(
                "controllerchange",
                handleControllerChange
            );

            if (registrationRef && updateFoundHandler) {
                registrationRef.removeEventListener(
                    "updatefound",
                    updateFoundHandler
                );
            }
        };
    }, []);

    return null;
}
