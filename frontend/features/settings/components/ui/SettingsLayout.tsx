"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SettingsSidebar, SidebarItem } from "./SettingsSidebar";

interface SettingsLayoutProps {
    children: ReactNode;
    sidebarItems: SidebarItem[];
    isAdmin: boolean;
}

export function SettingsLayout({ children, sidebarItems, isAdmin }: SettingsLayoutProps) {
    const [activeSection, setActiveSection] = useState(sidebarItems[0]?.id || "");
    const mainContentRef = useRef<HTMLDivElement>(null);
    
    // Handle sidebar click - scroll to section
    const handleSectionClick = useCallback((id: string) => {
        const element = document.getElementById(id);
        if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "start" });
            setActiveSection(id);
        }
    }, []);
    
    // Track active section based on scroll position
    useEffect(() => {
        const visibleItems = sidebarItems.filter(item => !item.adminOnly || isAdmin);
        
        // Find the scrollable parent (the main element in AuthenticatedLayout)
        const findScrollableParent = (el: HTMLElement | null): HTMLElement | null => {
            while (el) {
                const style = window.getComputedStyle(el);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        };
        
        const scrollContainer = mainContentRef.current 
            ? findScrollableParent(mainContentRef.current) 
            : null;
        
        if (!scrollContainer) return;
        
        // Use scroll event for smooth tracking
        const handleScroll = () => {
            const containerRect = scrollContainer.getBoundingClientRect();
            const offset = 150; // Offset from top
            
            // Find the section that's currently in view
            let currentSection = visibleItems[0]?.id || "";
            
            for (const item of visibleItems) {
                const element = document.getElementById(item.id);
                if (element) {
                    const rect = element.getBoundingClientRect();
                    // Check if element top is above the offset line
                    if (rect.top <= containerRect.top + offset) {
                        currentSection = item.id;
                    }
                }
            }
            
            setActiveSection(prev => {
                if (prev !== currentSection) {
                    return currentSection;
                }
                return prev;
            });
        };
        
        // Throttle scroll events
        let ticking = false;
        const scrollHandler = () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    handleScroll();
                    ticking = false;
                });
                ticking = true;
            }
        };
        
        scrollContainer.addEventListener("scroll", scrollHandler, { passive: true });
        
        // Initial check
        handleScroll();
        
        return () => scrollContainer.removeEventListener("scroll", scrollHandler);
    }, [sidebarItems, isAdmin]);
    
    return (
        <div className="min-h-screen bg-[#0a0a0a] relative">
            {/* Subtle grey gradient for systems page feel */}
            <div 
                className="absolute inset-0 pointer-events-none"
                style={{
                    backgroundImage: 'linear-gradient(to bottom, #1a1a1a 0%, #121212 15%, #0a0a0a 30%)'
                }}
            />
            
            <div className="relative max-w-5xl mx-auto px-4 md:px-8 py-8">
                {/* Header */}
                <h1 className="text-2xl font-bold text-white mb-8">Settings</h1>
                
                {/* Layout */}
                <div className="flex gap-12">
                    {/* Sidebar */}
                    <SettingsSidebar
                        items={sidebarItems}
                        activeSection={activeSection}
                        onSectionClick={handleSectionClick}
                        isAdmin={isAdmin}
                    />
                    
                    {/* Main Content */}
                    <main ref={mainContentRef} className="flex-1 min-w-0">
                        {children}
                    </main>
                </div>
            </div>
        </div>
    );
}

