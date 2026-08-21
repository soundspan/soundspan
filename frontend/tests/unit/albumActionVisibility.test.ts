import assert from "node:assert/strict";
import test from "node:test";
import {
    getAlbumActionVisibility,
    isSyntheticRgMbid,
} from "../../features/album/albumActionVisibility";

const baseInput = {
    source: "discovery" as const,
    owned: false,
    albumId: "album-1",
    rgMbid: "real-release-group",
    downloadsEnabled: true,
    hasAddAllToQueue: true,
    hasAlbumPreferenceAction: true,
    isInListenTogetherGroup: false,
};

test("synthetic release-group identifiers are not acquisition MBIDs", () => {
    assert.equal(isSyntheticRgMbid("remote:generated-hash"), true);
    assert.equal(isSyntheticRgMbid("real-release-group"), false);
    assert.equal(isSyntheticRgMbid(undefined), false);
});

test("album action visibility keeps synthetic remote albums playable but not acquirable", () => {
    const visibility = getAlbumActionVisibility({
        ...baseInput,
        source: "remote",
        rgMbid: "remote:generated-hash",
    });

    assert.equal(visibility.isLibraryVisible, true);
    assert.equal(visibility.showAcquisition, false);
    assert.equal(visibility.canShowAddToPlaylist, true);
    assert.equal(visibility.canShowAlbumPreference, false);
});

test("album action visibility permits acquisition for a real remote release group", () => {
    const visibility = getAlbumActionVisibility({
        ...baseInput,
        source: "remote",
    });

    assert.equal(visibility.showAcquisition, true);
    assert.equal(visibility.acquisitionMbid, "real-release-group");
});

test("album action visibility applies ownership, feature, and group policy", () => {
    const owned = getAlbumActionVisibility({
        ...baseInput,
        source: "library",
        owned: true,
        downloadsEnabled: false,
        isInListenTogetherGroup: true,
    });

    assert.equal(owned.showAcquisition, false);
    assert.equal(owned.canShowAlbumPreference, true);
    assert.equal(owned.hasLockedControls, true);
    assert.equal(owned.hasActionControls, true);
});
