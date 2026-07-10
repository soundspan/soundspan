import assert from "node:assert/strict";
import test from "node:test";
import {
    detectAndroidWebView,
    resolveDirectEngineSelection,
} from "../../lib/audio-engine/engineSelectionPolicy";

const ANDROID_WEBVIEW_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36";
const ANDROID_CHROME_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME_UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

test("detectAndroidWebView flags Android WebView user agents only", () => {
    assert.equal(detectAndroidWebView(ANDROID_WEBVIEW_UA), true);
    assert.equal(detectAndroidWebView(ANDROID_CHROME_UA), false);
    assert.equal(detectAndroidWebView(DESKTOP_CHROME_UA), false);
    assert.equal(detectAndroidWebView(""), false);
});

test("default mode selects howler and allows the Tauri upgrade path", () => {
    const decision = resolveDirectEngineSelection({
        mode: "howler",
        isAndroidWebView: false,
    });
    assert.equal(decision.engine, "howler");
    assert.equal(decision.allowTauriUpgrade, true);
    assert.equal(decision.reason, "default_direct_engine");
});

test("videojs mode keeps howler in the direct slot (segmented engine is separate)", () => {
    const decision = resolveDirectEngineSelection({
        mode: "videojs",
        isAndroidWebView: false,
    });
    assert.equal(decision.engine, "howler");
    assert.equal(decision.allowTauriUpgrade, true);
});

test("native mode selects the native element engine and suppresses Tauri upgrade", () => {
    const decision = resolveDirectEngineSelection({
        mode: "native",
        isAndroidWebView: false,
    });
    assert.equal(decision.engine, "native");
    assert.equal(decision.allowTauriUpgrade, false);
    assert.equal(decision.reason, "native_mode_flag");
});

test("Android WebView platform pin overrides the native mode flag", () => {
    const decision = resolveDirectEngineSelection({
        mode: "native",
        isAndroidWebView: true,
    });
    assert.equal(decision.engine, "howler");
    assert.equal(decision.reason, "android_webview_pin");
});

test("native mode never allows the Tauri auto-upgrade, even under the WebView pin", () => {
    const decision = resolveDirectEngineSelection({
        mode: "native",
        isAndroidWebView: true,
    });
    assert.equal(decision.allowTauriUpgrade, false);
});

test("Android WebView under non-native modes keeps current behavior (howler + Tauri upgrade allowed)", () => {
    const decision = resolveDirectEngineSelection({
        mode: "howler",
        isAndroidWebView: true,
    });
    assert.equal(decision.engine, "howler");
    assert.equal(decision.allowTauriUpgrade, true);
});

test("tauri-native mode keeps howler in the direct slot pending the async upgrade", () => {
    const decision = resolveDirectEngineSelection({
        mode: "tauri-native",
        isAndroidWebView: false,
    });
    assert.equal(decision.engine, "howler");
    assert.equal(decision.allowTauriUpgrade, true);
});
