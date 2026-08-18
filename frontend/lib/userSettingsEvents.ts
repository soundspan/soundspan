/**
 * Window event dispatched after a successful user-settings save so
 * long-lived surfaces (the audio player) can refresh preferences they
 * read outside the settings page's query cache.
 */
export const USER_SETTINGS_UPDATED_EVENT = "soundspan:user-settings-updated";

/** Fires the settings-updated event when running in a browser context. */
export function emitUserSettingsUpdated(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
}
