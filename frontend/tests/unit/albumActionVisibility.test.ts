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
    requestsEnabled: false,
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

test("request affordance shows for non-admin viewers on unowned real albums", () => {
    const visibility = getAlbumActionVisibility({
        ...baseInput,
        downloadsEnabled: false,
        requestsEnabled: true,
    });

    assert.equal(visibility.showAcquisition, false);
    assert.equal(visibility.showRequest, true);
    assert.equal(visibility.hasActionControls, true);
});

test("request affordance hides for owned albums and synthetic identifiers", () => {
    const owned = getAlbumActionVisibility({
        ...baseInput,
        downloadsEnabled: false,
        requestsEnabled: true,
        source: "library",
        owned: true,
    });
    assert.equal(owned.showRequest, false);

    const synthetic = getAlbumActionVisibility({
        ...baseInput,
        downloadsEnabled: false,
        requestsEnabled: true,
        source: "remote",
        rgMbid: "remote:generated-hash",
    });
    assert.equal(synthetic.showRequest, false);
});

test("direct download wins over request when both capabilities are present", () => {
    const visibility = getAlbumActionVisibility({
        ...baseInput,
        downloadsEnabled: true,
        requestsEnabled: true,
    });

    assert.equal(visibility.showAcquisition, true);
    assert.equal(visibility.showRequest, false);
});
