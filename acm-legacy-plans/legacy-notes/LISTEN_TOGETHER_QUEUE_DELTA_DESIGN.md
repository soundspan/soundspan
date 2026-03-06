# Listen Together: Queue Delta Protocol (Phase 2 Design)

Status: **Proposed** | Created: 2026-03-05

## Context

Listen Together broadcasts the full queue array on every mutation via `group:state` and `group:queue-delta` events. At the current hard cap of 500 tracks (`MAX_QUEUE_SIZE` in `listenTogetherManager.ts`), each full-state broadcast is ~150KB. This fits within the 1MB `maxHttpBufferSize` but is wasteful — most mutations only add, remove, or reorder a single track.

The queue is hard-capped at 500 tracks: creation truncates to the first 500, and runtime add/insert-next operations reject with `INVALID` when the cap would be exceeded. If we want to raise this limit in the future, we need to send incremental queue operations instead of full replacements. This document describes that delta protocol design.

## Current Architecture

### Broadcast paths that include the full queue

| Call site | Trigger | Queue changes? |
|---|---|---|
| `modifyQueue()` → `onQueueDelta` | add, insert-next, remove, clear | Yes |
| `setTrack()` → `broadcastState` | next/prev/jump | No |
| `addSocket()` → `broadcastState` | Socket reconnect (presence) | No |
| `removeSocket()` → `broadcastState` | Socket disconnect (presence) | No |
| `addMember()` → `broadcastState` | Member join/rejoin | No |
| `removeMember()` → `broadcastState` | Member leave | No |
| `forcePlay()` → `broadcastState` | Ready gate passes | No |

### Key types (current)

```typescript
// listenTogetherManager.ts — misleadingly named, this is a full replacement
export interface QueueDelta {
    queue: SyncQueueItem[];      // entire queue array
    currentIndex: number;
    trackId: string | null;
    stateVersion: number;
}

// The manager already has structured action types
export type QueueAction =
    | { action: "add"; items: SyncQueueItem[] }
    | { action: "insert-next"; items: SyncQueueItem[] }
    | { action: "remove"; index: number }
    | { action: "reorder"; fromIndex: number; toIndex: number }
    | { action: "clear" };
```

## Proposed Design

### 1. New `QueueOp` event type

Replace full-queue broadcasts from `modifyQueue()` with operation-based deltas:

```typescript
export type QueueOp =
    | { op: "add"; items: SyncQueueItem[]; currentIndex: number; trackId: string | null; stateVersion: number }
    | { op: "insert-next"; afterIndex: number; items: SyncQueueItem[]; currentIndex: number; trackId: string | null; stateVersion: number }
    | { op: "remove"; index: number; currentIndex: number; trackId: string | null; stateVersion: number }
    | { op: "clear"; stateVersion: number };
```

New Socket.IO event: `group:queue-op`

### 2. Manager changes (`listenTogetherManager.ts`)

- Add `onQueueOp(groupId, op)` to `ManagerCallbacks`
- In `modifyQueue()`, emit the structured op instead of (or in addition to) the full queue
- Keep `onQueueDelta` as a fallback for cluster sync / backward compat during rollout

### 3. Socket layer changes (`listenTogetherSocket.ts`)

- Wire `onQueueOp` callback to emit `group:queue-op` to the room
- Keep `group:state` for initial join/reconnect (full snapshot catch-up path)

### 4. Client changes

#### `listen-together-socket.ts`
- Add `onQueueOp` callback to `ListenTogetherSocketCallbacks`
- Listen on `group:queue-op` event

#### `listen-together-context.tsx`
- Add `applyQueueOp()` handler that applies each op locally:
  - `add`: append items to queue array
  - `insert-next`: splice items after `afterIndex`
  - `remove`: splice out item at index, adjust `currentIndex`
  - `clear`: reset queue to empty
- Gap detection: if `op.stateVersion > lastAppliedVersion + 1`, request full resync

### 5. Gap detection and resync

```typescript
const applyQueueOp = useCallback((op: QueueOp) => {
    if (op.stateVersion <= lastAppliedVersionRef.current) return; // stale
    if (op.stateVersion > lastAppliedVersionRef.current + 1) {
        // Missed one or more ops — request full state
        listenTogetherSocket.requestResync();
        return;
    }
    lastAppliedVersionRef.current = op.stateVersion;
    // ... apply op locally
}, []);
```

Add `requestResync()` to the client socket class — emits `request-resync` to server. Server responds with `group:state` (full snapshot) to that socket only.

### 6. Split `broadcastState` for non-queue changes

Several `broadcastState` calls fire for presence-only changes (member connect/disconnect/join/leave). These don't change the queue but still send the full queue array. Convert these to a lightweight `group:members-delta` event:

```typescript
export interface MembersDelta {
    members: Array<{
        userId: string;
        username: string;
        isHost: boolean;
        joinedAt: string;
        isConnected: boolean;
    }>;
    syncState: GroupSyncState;
    stateVersion: number;
}
```

Call sites to convert:
- `addSocket()` line 429 — presence transition
- `removeSocket()` line 444 — presence transition
- `addMember()` lines 481, 501 — member join
- `removeMember()` line 551 — member leave

Call sites that should stay as `broadcastState` (full snapshot):
- `setTrack()` lines 669, 682 — clients need full state for track change + ready gate
- `forcePlay()` line 1150 — clients need full state after ready gate resolves

### 7. Cluster sync considerations

The Redis cluster sync (`listenTogetherClusterSync.ts`) currently publishes full `GroupSnapshot` objects. This should continue — cluster sync is periodic (not per-mutation) and needs the authoritative full state. No changes needed here.

## Bandwidth Impact

| Scenario (2000 tracks) | Current | With QueueOp |
|---|---|---|
| Add 1 track | ~600KB | ~0.5KB |
| Remove 1 track | ~600KB | ~0.1KB |
| Next/prev track | ~600KB | ~0.3KB (PlaybackDelta) |
| Member join/leave | ~600KB | ~2KB (MembersDelta) |
| Initial join / resync | ~600KB | ~600KB (full snapshot, unchanged) |

## Migration Strategy

1. Server emits **both** `group:queue-op` and `group:queue-delta` during rollout
2. Updated clients listen for `group:queue-op` and ignore `group:queue-delta` when ops are available
3. Legacy clients continue receiving `group:queue-delta` (full replacement)
4. After all clients update, remove `group:queue-delta` emission

## Risk Assessment

**Client queue divergence** is the primary risk. If a client misses a `queue-op` (flaky WebSocket, browser tab backgrounded), their queue silently drifts from the server. Mitigations:
- `stateVersion` gap detection triggers immediate full resync
- Full `group:state` snapshot continues to fire for track changes and ready gates
- `requestResync` provides explicit recovery path

**Testing requirements:**
- Unit tests for each op type applied to client-side queue state
- Tests for gap detection triggering resync
- Tests for out-of-order / duplicate op handling
- Integration test: add tracks on one client, verify other client's queue matches

## Files to Modify

| File | Changes |
|---|---|
| `backend/src/services/listenTogetherManager.ts` | Add `QueueOp` type, `onQueueOp` callback, `MembersDelta` type, `onMembersDelta` callback, split `broadcastState` |
| `backend/src/services/listenTogetherSocket.ts` | Wire new callbacks, add `request-resync` handler |
| `frontend/lib/listen-together-socket.ts` | Add `QueueOp` + `MembersDelta` types, `onQueueOp` + `onMembersDelta` callbacks, `requestResync()` method |
| `frontend/lib/listen-together-context.tsx` | Add `applyQueueOp()` + `applyMembersDelta()`, gap detection |
| Tests for all of the above | |
