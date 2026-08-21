import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    QueryClient,
    QueryClientProvider,
    QueryObserver,
} from "@tanstack/react-query";

type Settings = {
    showYtMusicExplore?: boolean;
    showTidalExplore?: boolean;
};

let getSettings = async (): Promise<Settings> => ({});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getSettings: () => getSettings(),
        },
    },
});

async function readPrefs(queryClient: QueryClient) {
    const { useUserSettingsExplorePrefs } =
        await import("../../features/explore/hooks/useUserSettingsExplorePrefs");
    const captured = {
        current: null as ReturnType<typeof useUserSettingsExplorePrefs> | null,
    };
    const Probe = () => {
        captured.current = useUserSettingsExplorePrefs();
        return null;
    };
    renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Probe),
        ),
    );
    if (!captured.current)
        throw new Error("Explore preferences hook did not run");
    return captured.current;
}

test("settings errors fail closed and a later success restores provider preferences", async () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const fetchSettings = () => getSettings();
    getSettings = async () => {
        throw new Error("Settings unavailable");
    };

    await assert.rejects(
        queryClient.fetchQuery({
            queryKey: ["user-settings"],
            queryFn: fetchSettings,
            retry: false,
        }),
        /Settings unavailable/,
    );
    const failedQuery = new QueryObserver(queryClient, {
        queryKey: ["user-settings"],
        queryFn: fetchSettings,
        retry: false,
    }).getCurrentResult();
    assert.equal(failedQuery.isFetched, true);
    assert.equal(failedQuery.isSuccess, false);

    const failedPrefs = await readPrefs(queryClient);
    assert.deepEqual(failedPrefs, {
        showYtMusicExplore: false,
        showTidalExplore: false,
    });

    getSettings = async () => ({
        showYtMusicExplore: false,
        showTidalExplore: true,
    });
    await queryClient.refetchQueries({
        queryKey: ["user-settings"],
        exact: true,
        type: "all",
    });
    const recoveredPrefs = await readPrefs(queryClient);
    assert.deepEqual(recoveredPrefs, {
        showYtMusicExplore: false,
        showTidalExplore: true,
    });
});

test("background refetch errors retain cached provider preferences", async () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const fetchSettings = () => getSettings();
    getSettings = async () => ({
        showYtMusicExplore: true,
        showTidalExplore: false,
    });
    await queryClient.fetchQuery({
        queryKey: ["user-settings"],
        queryFn: fetchSettings,
    });

    getSettings = async () => {
        throw new Error("Background settings refresh failed");
    };
    await queryClient.refetchQueries({
        queryKey: ["user-settings"],
        exact: true,
        type: "all",
    });

    const refetchError = new QueryObserver(queryClient, {
        queryKey: ["user-settings"],
        queryFn: fetchSettings,
        retry: false,
    }).getCurrentResult();
    assert.equal(refetchError.isRefetchError, true);
    assert.deepEqual(refetchError.data, {
        showYtMusicExplore: true,
        showTidalExplore: false,
    });
    assert.deepEqual(await readPrefs(queryClient), {
        showYtMusicExplore: true,
        showTidalExplore: false,
    });
});
