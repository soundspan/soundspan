"use client";

import { useState, useEffect, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

const ACTIVITY_PANEL_KEY = "soundspan_activity_panel_open";

export type ActivityPanelTab = "notifications" | "active" | "history" | "social";

export interface UseActivityPanelReturn {
    isOpen: boolean;
    activeTab: ActivityPanelTab;
    setActiveTab: Dispatch<SetStateAction<ActivityPanelTab>>;
    toggle: () => void;
    open: () => void;
    close: () => void;
}

export function useActivityPanel(): UseActivityPanelReturn {
    const [isOpen, setIsOpen] = useState(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem(ACTIVITY_PANEL_KEY) === "true";
    });
    const [activeTab, setActiveTab] = useState<ActivityPanelTab>("notifications");

    // Persist state to localStorage
    useEffect(() => {
        if (typeof window !== "undefined") {
            localStorage.setItem(ACTIVITY_PANEL_KEY, isOpen ? "true" : "false");
        }
    }, [isOpen]);

    const toggle = useCallback(() => {
        setIsOpen((prev) => !prev);
    }, []);

    const open = useCallback(() => {
        setIsOpen(true);
    }, []);

    const close = useCallback(() => {
        setIsOpen(false);
    }, []);

    return {
        isOpen,
        activeTab,
        setActiveTab,
        toggle,
        open,
        close,
    };
}
