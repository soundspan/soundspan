export const DEFAULT_AUDIO_VOLUME = 0.5;

export function clampAudioVolume(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_AUDIO_VOLUME;
    return Math.max(0, Math.min(1, value));
}

/**
 * Parse persisted volume values defensively so reloads always rehydrate
 * to a stable and valid value.
 */
export function resolveInitialAudioVolume(
    raw: string | null | undefined
): number {
    if (!raw) return DEFAULT_AUDIO_VOLUME;
    return clampAudioVolume(Number.parseFloat(raw));
}
