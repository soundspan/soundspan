import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveForegroundRecoveryDecision,
  isPreservableNetworkError,
  shouldThrottleForegroundRecovery,
  resetForegroundRecoveryThrottle,
  type ForegroundRecoveryInput,
} from "../../lib/audio-engine/foregroundRecoveryPolicy";

// --- resolveForegroundRecoveryDecision ---

test("recovers when visible, was playing when hidden, and engine stopped", () => {
  const decision = resolveForegroundRecoveryDecision({
    isVisible: true,
    wasPlayingWhenHidden: true,
    engineIsPlaying: false,
    machineState: "ERROR",
  });
  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "foreground_resume");
});

test("does not recover when page is not visible", () => {
  const decision = resolveForegroundRecoveryDecision({
    isVisible: false,
    wasPlayingWhenHidden: true,
    engineIsPlaying: false,
    machineState: "IDLE",
  });
  assert.equal(decision.shouldRecover, false);
  assert.equal(decision.reason, "page_not_visible");
});

test("does not recover when audio was not playing when page was hidden", () => {
  const decision = resolveForegroundRecoveryDecision({
    isVisible: true,
    wasPlayingWhenHidden: false,
    engineIsPlaying: false,
    machineState: "IDLE",
  });
  assert.equal(decision.shouldRecover, false);
  assert.equal(decision.reason, "not_playing_when_hidden");
});

test("does not recover when engine is still playing", () => {
  const decision = resolveForegroundRecoveryDecision({
    isVisible: true,
    wasPlayingWhenHidden: true,
    engineIsPlaying: true,
    machineState: "PLAYING",
  });
  assert.equal(decision.shouldRecover, false);
  assert.equal(decision.reason, "engine_still_playing");
});

test("does not recover when already in LOADING state", () => {
  const decision = resolveForegroundRecoveryDecision({
    isVisible: true,
    wasPlayingWhenHidden: true,
    engineIsPlaying: false,
    machineState: "LOADING",
  });
  assert.equal(decision.shouldRecover, false);
  assert.equal(decision.reason, "already_recovering");
});

test("does not recover when already in RECOVERING state", () => {
  const decision = resolveForegroundRecoveryDecision({
    isVisible: true,
    wasPlayingWhenHidden: true,
    engineIsPlaying: false,
    machineState: "RECOVERING",
  });
  assert.equal(decision.shouldRecover, false);
  assert.equal(decision.reason, "already_recovering");
});

test("recovers from IDLE state when was playing when hidden", () => {
  const decision = resolveForegroundRecoveryDecision({
    isVisible: true,
    wasPlayingWhenHidden: true,
    engineIsPlaying: false,
    machineState: "IDLE",
  });
  assert.equal(decision.shouldRecover, true);
});

test("recovers from BUFFERING state when was playing when hidden", () => {
  const decision = resolveForegroundRecoveryDecision({
    isVisible: true,
    wasPlayingWhenHidden: true,
    engineIsPlaying: false,
    machineState: "BUFFERING",
  });
  assert.equal(decision.shouldRecover, true);
});

test("does not recover when user paused before switching tabs (desktop regression fix)", () => {
  // Desktop scenario: user plays track, pauses, switches tab, returns.
  // wasPlayingWhenHidden is false because audio was paused at hide time.
  const decision = resolveForegroundRecoveryDecision({
    isVisible: true,
    wasPlayingWhenHidden: false,
    engineIsPlaying: false,
    machineState: "READY",
  });
  assert.equal(decision.shouldRecover, false);
  assert.equal(decision.reason, "not_playing_when_hidden");
});

// --- isPreservableNetworkError ---

test("MEDIA_ERR_NETWORK (code 2) is preservable", () => {
  assert.equal(isPreservableNetworkError(2), true);
});

test("MEDIA_ERR_DECODE (code 3) is not preservable", () => {
  assert.equal(isPreservableNetworkError(3), false);
});

test("null error code is not preservable", () => {
  assert.equal(isPreservableNetworkError(null), false);
});

test("MEDIA_ERR_ABORTED (code 1) is not preservable", () => {
  assert.equal(isPreservableNetworkError(1), false);
});

// --- shouldThrottleForegroundRecovery ---

test("first recovery attempt is not throttled", () => {
  resetForegroundRecoveryThrottle();
  assert.equal(shouldThrottleForegroundRecovery(), false);
});

test("immediate second attempt is throttled", () => {
  resetForegroundRecoveryThrottle();
  shouldThrottleForegroundRecovery(); // first — not throttled
  assert.equal(shouldThrottleForegroundRecovery(), true); // second — throttled
});

test("attempt after cooldown is not throttled", async () => {
  resetForegroundRecoveryThrottle();
  shouldThrottleForegroundRecovery(); // first
  // Simulate time passing by resetting
  resetForegroundRecoveryThrottle();
  assert.equal(shouldThrottleForegroundRecovery(), false);
});
