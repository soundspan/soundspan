# soundspan 1.3.3 Release Notes - 2026-03-07

## Release Summary

soundspan 1.3.3 fixes a bug where tracks would not advance to the next song in the queue when the phone screen is locked or the browser tab is in the background. Audio session management is now always active on all platforms, and the `HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED` environment variable has been removed.

## Fixed

- Playback no longer gets stuck on a finished track when the phone screen is locked or the app is in a background tab. The audio engine now listens for the native HTML5 audio `ended` event as a fallback, and foreground recovery on unlock detects completed tracks and advances to the next song automatically. This affects Android PWA, iOS PWA, and desktop browsers that throttle background timers.

## Changed

- Audio session configuration (auto-unlock, auto-suspend prevention, and `navigator.audioSession.type`) is now unconditionally active on all platforms. The `HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED` environment variable has been removed — lock-screen playback works out of the box with no configuration needed.
- Foreground recovery (previously labeled "iOS Foreground Recovery") is now platform-neutral and applies on all devices.

## Removed

- The `HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED` environment variable. If you had this set in your deployment, it can be safely removed from your `.env`, Helm values, or Docker configuration. The behavior it enabled is now always on.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 1.3.3
```

## Breaking Changes

No breaking changes in this release. The removed environment variable was optional and its absence is handled gracefully.

## Known Issues

- YouTube Music personalized mixes (My Mix, Discover Mix, etc.) are implemented but dormant due to an upstream YouTube API limitation tracked in ytmusic-api issue #813. The feature will activate automatically once the upstream blocker is resolved.

## Compatibility and Migration

No migration steps required. This is a drop-in replacement for 1.3.2. If your deployment sets `HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED`, remove it at your convenience — the variable is now ignored.

## Full Changelog

- Compare changes: https://github.com/soundspan/soundspan/compare/v1.3.2...v1.3.3
- Full changelog: https://github.com/soundspan/soundspan/blob/main/CHANGELOG.md
