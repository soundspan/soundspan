import test from "node:test";
import assert from "node:assert/strict";
import {
    buildUnifiedPlaylistRows,
    localPlaylistHref,
    peerPlaylistHref,
    type LocalPlaylistInput,
    type PeerPlaylistInput,
} from "../../lib/unifiedPlaylists";

const localMine: LocalPlaylistInput = {
    id: "pl-1",
    name: "Morning Mix",
    trackCount: 12,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    isOwner: true,
};

const localShared: LocalPlaylistInput = {
    id: "pl-2",
    name: "Karen's Favorites",
    trackCount: 30,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    isOwner: false,
    user: { username: "karen" },
};

const localHidden: LocalPlaylistInput = {
    id: "pl-3",
    name: "Hidden",
    isHidden: true,
    isOwner: false,
};

const peerOne: PeerPlaylistInput = {
    remoteId: "remote-1",
    name: "Zeta Peer Jams",
    trackCount: 8,
    updatedAt: "2026-08-15T00:00:00.000Z",
    owner: { displayName: "Sam" },
    peer: { id: "peer-a", name: "Family server" },
};

test("all filter merges local and peer rows, excluding hidden", () => {
    const rows = buildUnifiedPlaylistRows(
        [localMine, localShared, localHidden],
        [peerOne],
        { filter: "all", sort: "updated" },
    );
    assert.deepEqual(
        rows.map((r) => r.key),
        ["local:pl-1", "peer:peer-a:remote-1", "local:pl-2"],
    );
});

test("filters isolate mine, others, and peers", () => {
    const inputs = [localMine, localShared] as const;
    const mine = buildUnifiedPlaylistRows([...inputs], [peerOne], {
        filter: "mine",
        sort: "updated",
    });
    assert.deepEqual(
        mine.map((r) => r.key),
        ["local:pl-1"],
    );
    const others = buildUnifiedPlaylistRows([...inputs], [peerOne], {
        filter: "others",
        sort: "updated",
    });
    assert.deepEqual(
        others.map((r) => r.key),
        ["local:pl-2"],
    );
    const peers = buildUnifiedPlaylistRows([...inputs], [peerOne], {
        filter: "peers",
        sort: "updated",
    });
    assert.deepEqual(
        peers.map((r) => r.key),
        ["peer:peer-a:remote-1"],
    );
});

test("peer rows sort by updatedAt under the created sort", () => {
    const rows = buildUnifiedPlaylistRows([localMine, localShared], [peerOne], {
        filter: "all",
        sort: "created",
    });
    assert.deepEqual(
        rows.map((r) => r.key),
        ["peer:peer-a:remote-1", "local:pl-2", "local:pl-1"],
    );
});

test("alphabetical sort is name-ordered across kinds", () => {
    const rows = buildUnifiedPlaylistRows([localMine, localShared], [peerOne], {
        filter: "all",
        sort: "alphabetical",
    });
    assert.deepEqual(
        rows.map((r) => r.name),
        ["Karen's Favorites", "Morning Mix", "Zeta Peer Jams"],
    );
});

test("peer rows carry badge metadata and composite identity", () => {
    const [row] = buildUnifiedPlaylistRows([], [peerOne], {
        filter: "peers",
        sort: "updated",
    });
    assert.equal(row.kind, "peer");
    if (row.kind === "peer") {
        assert.equal(row.peerName, "Family server");
        assert.equal(row.ownerName, "Sam");
        assert.equal(row.href, "/peer-playlists/peer-a/remote-1");
    }
});

test("href helpers encode identifiers", () => {
    assert.equal(localPlaylistHref("a b"), "/playlist/a%20b");
    assert.equal(peerPlaylistHref("p/1", "r 2"), "/peer-playlists/p%2F1/r%202");
});

test("filter options gate the peers entry on federation", async () => {
    const { playlistFilterOptions } =
        await import("../../lib/unifiedPlaylists");
    assert.deepEqual(
        playlistFilterOptions(false).map(([value]) => value),
        ["all", "mine", "others"],
    );
    assert.deepEqual(
        playlistFilterOptions(true).map(
            ([value, label]) => `${value}:${label}`,
        ),
        [
            "all:All playlists",
            "mine:Your playlists",
            "others:Shared playlists",
            "peers:Peer playlists",
        ],
    );
});

test("local rows without createdAt sort last under the created sort", () => {
    const undated: LocalPlaylistInput = {
        id: "pl-undated",
        name: "Undated",
        updatedAt: "2026-08-22T00:00:00.000Z",
        isOwner: true,
    };
    const rows = buildUnifiedPlaylistRows([localMine, undated], [], {
        filter: "all",
        sort: "created",
    });
    assert.deepEqual(
        rows.map((r) => r.key),
        ["local:pl-1", "local:pl-undated"],
    );
});
