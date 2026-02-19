# Changelog

All notable changes to soundspan are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Rebrand baseline initialized for soundspan.
- Added a one-command maintainer release-prep flow (`npm run release:prepare -- --version X.Y.Z`) that synchronizes frontend/backend package versions, Helm chart version/appVersion, and release image tags, with hard-coded package-name validation.
- Helm chart release workflow now waits for release-tagged GHCR images before publishing chart artifacts to `gh-pages`.

### Changed

- Clarified mobile direction across README, migration guidance, and device-link UI copy: soundspan is PWA-first, with Subsonic-compatible apps as mobile native clients.
- Player now auto-triggers Match Vibe on the last queued track (outside Listen Together, with repeat off) to extend playback instead of ending the queue.
- Updated shared thumbs preference controls to icon-only styling (no circular border chrome) with solid white-filled active thumb icons, preserving single-signal mutual exclusivity and most-recent-click override behavior.

### Fixed

- Activity Social tab no longer flickers to "Social status unavailable" during transient refresh failures when cached online users are already available.
- Route navigation no longer gets queued behind heavy cover-art fetch bursts; sidebar primary links prefetch again and the service worker now bypasses Next.js route-transition requests.
