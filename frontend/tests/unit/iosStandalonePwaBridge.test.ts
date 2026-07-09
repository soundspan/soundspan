import assert from "node:assert/strict";
import test from "node:test";
import {
    IosStandaloneAudioContextBridge,
    shouldUseIosStandaloneAudioBridge,
    type BridgeAudioContextLike,
    type BridgeMediaElementSourceLike,
} from "../../lib/audio-engine/iosStandalonePwaBridge";

const IPHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPADOS_DESKTOP_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME_UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

test("bridge gate requires BOTH an iOS device AND standalone display mode", () => {
    assert.equal(
        shouldUseIosStandaloneAudioBridge({
            userAgent: IPHONE_UA,
            maxTouchPoints: 5,
            isStandaloneDisplayMode: true,
            isLegacyNavigatorStandalone: false,
        }),
        true,
    );
    // iOS Safari tab (not standalone) keeps the bare-element hi-res path.
    assert.equal(
        shouldUseIosStandaloneAudioBridge({
            userAgent: IPHONE_UA,
            maxTouchPoints: 5,
            isStandaloneDisplayMode: false,
            isLegacyNavigatorStandalone: false,
        }),
        false,
    );
    // Desktop/Android never bridge, standalone or not.
    assert.equal(
        shouldUseIosStandaloneAudioBridge({
            userAgent: DESKTOP_CHROME_UA,
            maxTouchPoints: 0,
            isStandaloneDisplayMode: true,
            isLegacyNavigatorStandalone: false,
        }),
        false,
    );
    assert.equal(
        shouldUseIosStandaloneAudioBridge({
            userAgent: ANDROID_UA,
            maxTouchPoints: 5,
            isStandaloneDisplayMode: true,
            isLegacyNavigatorStandalone: false,
        }),
        false,
    );
});

test("bridge gate recognizes iPadOS desktop-mode UA via touch points", () => {
    assert.equal(
        shouldUseIosStandaloneAudioBridge({
            userAgent: IPADOS_DESKTOP_UA,
            maxTouchPoints: 5,
            isStandaloneDisplayMode: true,
            isLegacyNavigatorStandalone: false,
        }),
        true,
    );
    // A real Mac has no touch points.
    assert.equal(
        shouldUseIosStandaloneAudioBridge({
            userAgent: IPADOS_DESKTOP_UA,
            maxTouchPoints: 0,
            isStandaloneDisplayMode: true,
            isLegacyNavigatorStandalone: false,
        }),
        false,
    );
});

test("bridge gate honors the legacy navigator.standalone flag", () => {
    assert.equal(
        shouldUseIosStandaloneAudioBridge({
            userAgent: IPHONE_UA,
            maxTouchPoints: 5,
            isStandaloneDisplayMode: false,
            isLegacyNavigatorStandalone: true,
        }),
        true,
    );
});

interface FakeSource extends BridgeMediaElementSourceLike {
    connectedTo: unknown[];
}

class FakeAudioContext implements BridgeAudioContextLike {
    state: AudioContextState = "suspended";
    destination = { fake: "destination" } as unknown as AudioDestinationNode;
    sources: FakeSource[] = [];
    resumeCalls = 0;
    closeCalls = 0;

    createMediaElementSource(): FakeSource {
        const source: FakeSource = {
            connectedTo: [],
            connect: (target: unknown) => {
                source.connectedTo.push(target);
            },
        };
        this.sources.push(source);
        return source;
    }

    resume(): Promise<void> {
        this.resumeCalls += 1;
        this.state = "running";
        return Promise.resolve();
    }

    close(): Promise<void> {
        this.closeCalls += 1;
        this.state = "closed";
        return Promise.resolve();
    }
}

const fakeElement = {} as HTMLAudioElement;

test("ensureForElement lazily creates one context and one source per element", () => {
    let created = 0;
    let context: FakeAudioContext | null = null;
    const bridge = new IosStandaloneAudioContextBridge(() => {
        created += 1;
        context = new FakeAudioContext();
        return context;
    });

    assert.equal(bridge.isActive(), false);
    bridge.ensureForElement(fakeElement);
    bridge.ensureForElement(fakeElement);
    bridge.ensureForElement(fakeElement);

    assert.equal(created, 1);
    assert.equal(bridge.isActive(), true);
    assert.equal(context!.sources.length, 1);
    assert.equal(context!.sources[0].connectedTo.length, 1);
    assert.equal(context!.sources[0].connectedTo[0], context!.destination);
});

test("resumeIfSuspended resumes only a suspended context", () => {
    let context: FakeAudioContext | null = null;
    const bridge = new IosStandaloneAudioContextBridge(() => {
        context = new FakeAudioContext();
        return context;
    });
    bridge.resumeIfSuspended();
    assert.equal(context, null, "no context is created just to resume");

    bridge.ensureForElement(fakeElement);
    bridge.resumeIfSuspended();
    assert.equal(context!.resumeCalls, 1);
    bridge.resumeIfSuspended();
    assert.equal(context!.resumeCalls, 1, "running context is not re-resumed");
});

test("close tears down the context and allows a fresh bridge", () => {
    let context: FakeAudioContext | null = null;
    const bridge = new IosStandaloneAudioContextBridge(() => {
        context = new FakeAudioContext();
        return context;
    });
    bridge.ensureForElement(fakeElement);
    bridge.close();
    assert.equal(context!.closeCalls, 1);
    assert.equal(bridge.isActive(), false);
});
