import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
/**
 * Performance monitoring hook - catches long tasks and reports them
 * Add this once to your root layout to monitor all performance issues
 */

import { useEffect } from 'react';

export function usePerformanceMonitor(enabled = true) {
    useEffect(() => {
        if (!enabled || typeof window === 'undefined') return;

        // Monitor long tasks (>50ms)
        const longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (entry.duration > 50) {
                    sharedFrontendLogger.warn(
                        `[LONG TASK] ${entry.duration.toFixed(1)}ms`,
                        entry.name,
                        entry
                    );
                }
            }
        });

        try {
            longTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch {
            // longtask not supported in all browsers
            sharedFrontendLogger.info('[PERF] Long task monitoring not supported');
        }

        // Monitor layout shifts
        const layoutShiftObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const layoutEntry = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
                if (layoutEntry.value > 0.1) {
                    sharedFrontendLogger.warn(
                        `[LAYOUT SHIFT] Score: ${layoutEntry.value.toFixed(3)}`,
                        layoutEntry.hadRecentInput ? '(user input)' : '(unexpected)',
                        entry
                    );
                }
            }
        });

        try {
            layoutShiftObserver.observe({ entryTypes: ['layout-shift'] });
        } catch {
            // Not supported
        }

        // Frame drop detection via rAF disabled - adds overhead
        // Long task observer is more useful for debugging

        // Log fetch requests that take too long
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
            const start = performance.now();
            const input = args[0];
            const url = typeof input === 'string'
                ? input
                : input instanceof URL
                    ? input.href
                    : input instanceof Request
                        ? input.url
                        : 'unknown';

            try {
                const result = await originalFetch(...args);
                const duration = performance.now() - start;

                if (duration > 500) {
                    sharedFrontendLogger.warn(`[SLOW FETCH] ${duration.toFixed(0)}ms - ${url}`);
                }

                return result;
            } catch (e) {
                const duration = performance.now() - start;
                sharedFrontendLogger.error(`[FETCH ERROR] ${duration.toFixed(0)}ms - ${url}`, e);
                throw e;
            }
        };

        sharedFrontendLogger.info('[PERF] Performance monitoring enabled');

        return () => {
            longTaskObserver.disconnect();
            layoutShiftObserver.disconnect();
            window.fetch = originalFetch;
        };
    }, [enabled]);
}
