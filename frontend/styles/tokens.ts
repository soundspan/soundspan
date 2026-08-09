/** Custom soundspan color tokens shared by runtime checks and tests. */
export const DESIGN_TOKENS: Record<string, string> = {
    brand: "#3b82f6",
    "brand-dark": "#2563eb",
    "brand-hover": "#60a5fa",
    "brand-light": "#93c5fd",
    ai: "#2323ff",
    "ai-dark": "#1a1acc",
    "ai-hover": "#5b5bff",
    surface: "#0a0a0a",
    "surface-active": "#1c1c1c",
    "surface-elevated": "#181818",
    "surface-highlight": "#282828",
    "surface-hover": "#1a1a1a",
    "surface-overlay": "#141414",
    "surface-raised": "#0f0f0f",
    "surface-sunken": "#121212",
    line: "#262626",
    "line-muted": "#404040",
    "line-strong": "#333333",
    content: "#ffffff",
    "content-body": "#e5e5e5",
    "content-disabled": "#525252",
    "content-muted": "#737373",
    "content-secondary": "#a3a3a3",
    error: "#ef4444",
    success: "#22c55e",
    warning: "#f59e0b",
};

/** WCAG AA contrast threshold for normal text. */
export const AA_NORMAL = 4.5;

/** WCAG AA contrast threshold for large text. */
export const AA_LARGE = 3;

/** WCAG contrast threshold for non-text UI components and states. */
export const NON_TEXT = 3;

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
        throw new TypeError(`Expected a 6-digit hex color, received: ${hex}`);
    }

    return [
        Number.parseInt(hex.slice(1, 3), 16),
        Number.parseInt(hex.slice(3, 5), 16),
        Number.parseInt(hex.slice(5, 7), 16),
    ];
}

function linearizeSrgb(channel: number): number {
    const srgb = channel / 255;
    return srgb <= 0.04045
        ? srgb / 12.92
        : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Calculates WCAG relative luminance for a six-digit sRGB hex color. */
export function relativeLuminance(hex: string): number {
    const [red, green, blue] = parseHex(hex);
    return (
        0.2126 * linearizeSrgb(red) +
        0.7152 * linearizeSrgb(green) +
        0.0722 * linearizeSrgb(blue)
    );
}

/** Calculates the WCAG contrast ratio between two six-digit sRGB hex colors. */
export function contrastRatio(fgHex: string, bgHex: string): number {
    const foreground = relativeLuminance(fgHex);
    const background = relativeLuminance(bgHex);
    const lighter = Math.max(foreground, background);
    const darker = Math.min(foreground, background);
    return (lighter + 0.05) / (darker + 0.05);
}

function channelToHex(channel: number): string {
    return Math.round(channel).toString(16).padStart(2, "0");
}

/** Composites a six-digit foreground color over a six-digit background color. */
export function compositeOver(
    fgHex: string,
    bgHex: string,
    alpha: number
): string {
    const foreground = parseHex(fgHex);
    const background = parseHex(bgHex);
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
        throw new RangeError(`Expected alpha between 0 and 1, received: ${alpha}`);
    }

    const channels = foreground.map(
        (channel, index) => channel * alpha + background[index] * (1 - alpha)
    );
    return `#${channels.map(channelToHex).join("")}`;
}
