# [2.5.0] Release Notes - 2026-08-23

## Release Summary

2.5.0 introduces **music requests**: users who can't download music directly can now ask for it. A Request button appears on albums that aren't in the library, admins approve or decline from a new Requests page, and the requester gets notified when their music arrives. This first version is deliberately an MVP — album requests only, with a simple approve/decline flow — and it will grow in future releases.

Federation sharing also gets simpler. Presence and public playlists now follow one rule each: **Share online presence** controls whether people can see you (locally and on peer servers), and public playlists are visible to connected peers — no separate per-peer toggles to manage. Peer playlists now appear alongside your own in the sidebar and Playlists page, badged with the server they come from.

Rounding it out: a configurable playback source priority, YouTube Music as a download source, and important stability fixes for federation sync and audiobook libraries.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.5.0. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- If you already run 2.0.x or later, this is a plain rolling update. Database migrations run automatically on startup.
- Two behavior changes to know about before you upgrade:
  - **Presence now extends to peers automatically.** Users who have **Share online presence** turned on become visible to federated peer servers too, and every public playlist is shared with connected peers. Anyone who wants to stay local-only should turn off **Share online presence** or make playlists private.
  - **Music requests are on by default.** Non-admin users will see Request buttons after the upgrade. Turn the feature off with `FEATURE_REQUESTS=false` if you don't want it.

## Fixed

- Approving a music request now shows the download in the approving admin's activity panel instead of running invisibly under the requester's account. (#663)
- Entries on the Requests page link to their artist and album pages.
- Discover Weekly no longer downloads albums for non-admin users; acquiring new music is admin-only or request-mediated. (#663)
- Fixed a federation sync query that could exhaust database memory on servers syncing large peer libraries. (#713)
- Audiobook libraries now stay in step with Audiobookshelf in both directions: newly added books appear within about five minutes, and books deleted from Audiobookshelf are removed from soundspan (covers and listening state included) on the next full sync — with careful safeguards so a flaky or partial Audiobookshelf response never deletes anything. (#710, #712)

## Added

- **Music requests (MVP).** Non-admin users get a Request button on albums and Release Radar entries they can't download, plus per-album Request badges on artist pages. Admins review the queue on a new Requests page (open it from your avatar menu), where artist and album names link straight to their pages; approving starts the download through the server's normal download path. Requesters get notifications when a request is approved, declined, fulfilled, or fails. Limits: one open request per album per user and a daily cap per user (`REQUESTS_PER_USER_PER_DAY`, default 10). Kill switch: `FEATURE_REQUESTS=false`. This is the first slice of the request system — artist-level requests, auto-approval for trusted users, and per-user quotas are planned follow-ups. (#663)
- **Peer playlists you can actually use.** Browse a connected peer's public playlists, follow them with live availability, or copy the playable tracks into a playlist of your own. Sharing uses the existing federation connection; private playlists, account ids, and emails are never exposed.
- **Presence across servers.** Users who share their online presence now appear in the Social tab of federated peer servers, with the same privacy controls as local presence. Snapshots expire automatically if servers stop syncing.
- **Configurable playback source priority.** Choose the order soundspan tries sources when playing a track: the default is your library → peer libraries → TIDAL → YouTube Music. (#683)
- **YouTube Music album downloads.** Pick **YouTube Music (Albums)** as a download source (or fallback) in Admin → Download Preferences; albums download through the `ytmusic-streamer` sidecar with proper file naming and tags, then trigger a library scan. (#701)
- Federation admins can set the instance display name shown to peers, and the peer health panel now classifies connection failures and reports embedding-sync outcomes.

## Changed

- **One switch for presence, one rule for playlists.** The per-user "share with trusted peers" toggles and the admin "Show user status from peers" toggle are gone. **Share online presence** controls your visibility everywhere; **Share listening status** still controls whether people see what you're playing; public playlists are public, including to peers.
- Peer playlists appear alongside local playlists in the sidebar and on the Playlists page, badged with their server. Both surfaces gain a Local/Peers filter (only shown when federation is enabled).
- **Federation pairing is simpler**: the host admin issues a credential, the other server connects with it. The old pairing-code flow is removed. Setup errors now say what actually went wrong (unreachable, TLS, authorization, or invalid peer). Existing peer connections keep working unchanged. (#708)
- Tracks streamed from peers are now a first-class playback source: they rank between your own files and streaming providers while the peer is online, and fall back to a provider copy instead of failing when the peer goes offline. (#683)
- The TIDAL sidecar is renamed `tidal-downloader` → `tidal-streamer`. Old image names and network hostnames keep working as aliases — no action needed. (#701)

## Deprecated

- None documented in this release.

## Removed

- Federation pairing codes. Servers running versions that only support pairing codes can no longer pair against an upgraded server; upgrade both sides or use a host credential. In-flight codes stop working on upgrade. (#708)
- The old unimplemented release-radar download endpoint (it always returned an error); the Release Radar page now uses the real download and request flows. (#663)

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- New environment knobs: `FEATURE_REQUESTS` (default `true`) and `REQUESTS_PER_USER_PER_DAY` (default `10`). Both are plumbed through docker-compose and the AIO image.
- A lightweight background job (every 5 minutes) settles approved requests when their download finishes and notifies the requester.
- Non-admin users can no longer trigger downloads through any path, including the deprecated legacy Discover mode; requests are the only way non-admins bring new music in.
- New request metrics: `soundspan_music_requests_total{action}`.
- Node runtime images no longer ship npm/npx/corepack, removing a recurring source of CVE scan findings. (#671, #717)

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.5.0
```

## Breaking Changes

- Federation pairing codes are removed. A peer that only knows how to pair with codes must upgrade before it can pair with a 2.5.0 server. Existing established peer connections are unaffected. (#708)
- The per-user peer-sharing opt-outs are removed. Users who kept presence or public playlists local-only through those toggles are now shared with peers; the remedy is turning off **Share online presence** or making the playlist private. (See "Before you upgrade".)

## Known Issues

- The admin Requests page shows the newest 200 requests without pagination; filtering is client-side. Fine at typical scale, and pagination is planned with the request-system follow-ups (#725).

## Compatibility and Migration

- Database migrations run automatically on startup: the new music-request table is added, and the removed per-user and admin peer-sharing settings columns are dropped. No manual steps.
- Federation wire compatibility: 2.5.0 servers interoperate with 2.4.x peers for library sync and streaming. Pairing *new* connections requires the credential flow on both sides.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.5.0. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.4.1...2.5.0](https://github.com/soundspan/soundspan/compare/2.4.1...2.5.0)
- Full changelog: https://github.com/soundspan/soundspan/blob/2.5.0/CHANGELOG.md
