import assert from "node:assert/strict";
import test from "node:test";
import {
    getAlbumActionVisibility,
    isSyntheticRgMbid,
    resolveAcquisitionMbid,
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

const MATCHED = "8e8a6f1c-0000-4000-8000-000000000002";
const matchedPlaceholder = {
    ...baseInput,
    source: "remote" as const,
    rgMbid: "remote:generated-hash",
    matchedRgMbid: MATCHED,
};

test("a MusicBrainz match lets a streaming-only album be downloaded or requested", () => {
    const admin = getAlbumActionVisibility(matchedPlaceholder);
    assert.equal(admin.showAcquisition, true);
    assert.equal(admin.acquisitionMbid, MATCHED);

    const member = getAlbumActionVisibility({
        ...matchedPlaceholder,
        downloadsEnabled: false,
        requestsEnabled: true,
    });
    assert.equal(member.showRequest, true);
    assert.equal(member.acquisitionMbid, MATCHED);
});

test("a match the library already holds offers neither download nor request", () => {
    for (const policy of [
        { downloadsEnabled: true, requestsEnabled: false },
        { downloadsEnabled: false, requestsEnabled: true },
    ]) {
        const visibility = getAlbumActionVisibility({
            ...matchedPlaceholder,
            ...policy,
            matchedInLibrary: true,
        });
        assert.equal(visibility.acquisitionMbid, null);
        assert.equal(visibility.showAcquisition, false);
        assert.equal(visibility.showRequest, false);
        assert.equal(visibility.isLibraryVisible, true);
    }
});

test("the acquisition id prefers the match, then the release group, then the release", () => {
    assert.equal(
        resolveAcquisitionMbid({
            rgMbid: "remote:generated-hash",
            matchedRgMbid: MATCHED,
        }),
        MATCHED,
    );
    assert.equal(
        resolveAcquisitionMbid({ rgMbid: "release-group", mbid: "release" }),
        "release-group",
    );
    assert.equal(resolveAcquisitionMbid({ mbid: "release" }), "release");
    assert.equal(
        resolveAcquisitionMbid({
            rgMbid: "remote:generated-hash",
            matchedRgMbid: null,
        }),
        null,
    );
});
