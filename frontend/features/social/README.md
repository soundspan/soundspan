# Social Feature Domain

Start-here guide for `frontend/features/social`.

## Start Here

1. Route entrypoints: `frontend/app/page.tsx` (the "From your peers" shelf), `frontend/app/peer-playlists/[peerId]/[remoteId]/page.tsx` (peer playlist detail).
2. Peer presence in the Activity panel lives in `frontend/components/activity/PeerPresenceSection.tsx` (rendered by `SocialTab.tsx`), fed by `frontend/hooks/useSocialPresence.ts`.
3. Targeted verification commands:

- `npm --prefix frontend run test:component -- tests/component/peerPresenceSection.component.test.ts`
- `npm --prefix backend test -- federationPeerPlaylists federationPresence social`

## Scope

Cross-peer social surfaces (federation phase 0): browsing public playlists shared by federated peers (`hooks/usePeerPlaylists.ts`, `components/PeerPlaylistsShelf.tsx`) and the peer presence roster. The API boundary is `frontend/lib/api/peerPlaylists.ts`. Local-only social settings (presence/listening toggles) remain in the `settings` domain.
