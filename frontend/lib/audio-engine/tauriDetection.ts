/**
 * Check if running inside a Tauri application.
 */
export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/**
 * Check if the current platform needs native audio
 * (Chromium-based webview: Windows or Android).
 */
export async function needsNativeAudio(): Promise<boolean> {
  if (!isTauriEnvironment()) return false;

  try {
    const { platform } = await import("@tauri-apps/plugin-os");
    const os = await platform();
    return os === "windows" || os === "android";
  } catch {
    return false;
  }
}
