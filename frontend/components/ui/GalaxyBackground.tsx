"use client";

/**
 * GalaxyBackground Component
 *
 * Creates a subtle cosmic background effect with gradient.
 * Particle animations disabled for performance - they caused scroll lag.
 */

interface GalaxyBackgroundProps {
    /** Primary color extracted from Vibrant.js (e.g., "#8B4789") */
    primaryColor?: string;
    /** Optional secondary color (unused, kept for API compatibility) */
    secondaryColor?: string;
}

export function GalaxyBackground({ primaryColor }: GalaxyBackgroundProps = {}) {
    // Convert hex color to RGB values for opacity control
    const hexToRgb = (hex: string) => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    };

    // Use provided colors or default purple theme
    const baseColor = primaryColor ? hexToRgb(primaryColor) : null;

    return (
        <div
            className="fixed inset-0 pointer-events-none z-0 overflow-hidden"
            style={{
                // Use will-change for GPU acceleration during scroll
                // Removed contain: strict as it can cause repaint flash issues on some browsers
                willChange: 'auto',
                transform: 'translateZ(0)', // Force GPU layer
            }}
        >
            {/* Subtle gradient - fades from bottom to top */}
            {baseColor ? (
                <>
                    <div
                        className="absolute inset-0 bg-gradient-to-t to-transparent"
                        style={{
                            backgroundImage: `linear-gradient(to top, rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.15), rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.05), transparent)`
                        }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent" />
                </>
            ) : (
                <>
                    <div className="absolute inset-0 bg-gradient-to-t from-purple-950/15 via-purple-950/5 to-transparent" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent" />
                </>
            )}
            {/* Particle animations removed for performance - they caused scroll lag */}
        </div>
    );
}
