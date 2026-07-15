import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Interactive component tests for SpotlightSearch's F1 local track/artist
 * finder (mapSearch.ts) layered onto the existing submit-triggered CLAP
 * search. renderToStaticMarkup (the pattern used elsewhere in this tree, e.g.
 * vibePanels.component.test.ts) strips event handlers entirely, so — like
 * skipSecondsButtons.component.test.ts / universalPlayerRenderCount — this
 * suite mounts the REAL component under happy-dom via react-dom/client + act
 * and drives real typing/keyboard/click events. Only `@/lib/api` (the vibe
 * search boundary) and `@/hooks/useMediaQuery` (pinned to desktop, so the
 * pill renders expanded rather than the collapsed mobile magnifier) are
 * mocked; lucide-react icons render for real (they're plain SVGs).
 */

GlobalRegistrator.register();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const vibeSearchCalls: string[] = [];

mock.module("@/lib/api", {
    namedExports: {
        api: {
            vibeSearch: async (q: string) => {
                vibeSearchCalls.push(q);
                return { query: q, tracks: [{ id: "vibe-result-1" }] };
            },
        },
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useMediaQuery: () => false, // desktop: pill renders expanded, not collapsed
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        /* best-effort teardown */
    }
});

beforeEach(() => {
    vibeSearchCalls.length = 0;
});

function track(
    id: string,
    title: string,
    artist: string
): {
    id: string;
    x: number;
    y: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    dominantMood: string;
    moodScore: number;
    energy: number | null;
    valence: number | null;
} {
    return {
        id,
        x: 0.5,
        y: 0.5,
        title,
        artist,
        artistId: `artist-${id}`,
        albumId: `album-${id}`,
        coverUrl: null,
        dominantMood: "moodHappy",
        moodScore: 0.5,
        energy: 0.5,
        valence: 0.5,
    };
}

const tracks = [
    track("t1", "Midnight City", "M83"),
    track("t2", "City Lights", "Aurora"),
    track("t3", "Starlight", "Muse"),
];

async function mount(element: React.ReactElement) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(element);
    });
    return { container, root };
}

async function unmount(mounted: {
    container: HTMLDivElement;
    root: { unmount: () => void };
}) {
    await React.act(async () => {
        mounted.root.unmount();
    });
    mounted.container.remove();
}

function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("typing shows up to 8 ranked local track/artist matches in a dropdown", async () => {
    const { SpotlightSearch } = await import(
        "../../components/vibe/SpotlightSearch"
    );
    const onLocate = () => undefined;
    const onResults = () => undefined;
    const onClear = () => undefined;

    const mounted = await mount(
        React.createElement(SpotlightSearch, {
            tracks,
            onLocate,
            onResults,
            onClear,
        })
    );

    const input = mounted.container.querySelector(
        'input[aria-label="Spotlight a vibe"]'
    ) as HTMLInputElement;
    assert.ok(input, "expected the spotlight input");

    await React.act(async () => {
        input.focus();
        typeInto(input, "city");
    });

    const listbox = mounted.container.querySelector("#spotlight-listbox");
    assert.ok(listbox, "expected the match dropdown to be open");
    assert.match(listbox!.textContent ?? "", /City Lights/);
    assert.match(listbox!.textContent ?? "", /Midnight City/);
    // The trailing vibe-search row is always present.
    assert.match(listbox!.textContent ?? "", /Search this as a vibe/);

    await unmount(mounted);
});

test("Enter picks the highlighted local match and calls onLocate, keeping the query text", async () => {
    const { SpotlightSearch } = await import(
        "../../components/vibe/SpotlightSearch"
    );
    const located: string[] = [];

    const mounted = await mount(
        React.createElement(SpotlightSearch, {
            tracks,
            onLocate: (id: string) => located.push(id),
            onResults: () => undefined,
            onClear: () => undefined,
        })
    );

    const input = mounted.container.querySelector(
        'input[aria-label="Spotlight a vibe"]'
    ) as HTMLInputElement;

    await React.act(async () => {
        input.focus();
        typeInto(input, "midnight");
    });

    // "Midnight City" is a title-prefix match -> ranks first -> pre-highlighted.
    await React.act(async () => {
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        );
    });

    assert.deepEqual(located, ["t1"]);
    assert.equal(input.value, "midnight", "query text is kept after locating");
    assert.equal(vibeSearchCalls.length, 0, "must not have fired the vibe search");

    await unmount(mounted);
});

test("clicking a match row calls onLocate for that track", async () => {
    const { SpotlightSearch } = await import(
        "../../components/vibe/SpotlightSearch"
    );
    const located: string[] = [];

    const mounted = await mount(
        React.createElement(SpotlightSearch, {
            tracks,
            onLocate: (id: string) => located.push(id),
            onResults: () => undefined,
            onClear: () => undefined,
        })
    );

    const input = mounted.container.querySelector(
        'input[aria-label="Spotlight a vibe"]'
    ) as HTMLInputElement;

    await React.act(async () => {
        input.focus();
        typeInto(input, "aurora");
    });

    const option = mounted.container.querySelector(
        '[aria-label="City Lights by Aurora"]'
    ) as HTMLButtonElement | null;
    assert.ok(option, "expected a match row for City Lights by Aurora");

    await React.act(async () => {
        option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    assert.deepEqual(located, ["t2"]);

    await unmount(mounted);
});

test("ArrowDown moves the highlight onto the vibe-search row, and Enter there fires api.vibeSearch", async () => {
    const { SpotlightSearch } = await import(
        "../../components/vibe/SpotlightSearch"
    );
    const located: string[] = [];

    const mounted = await mount(
        React.createElement(SpotlightSearch, {
            tracks,
            onLocate: (id: string) => located.push(id),
            onResults: () => undefined,
            onClear: () => undefined,
        })
    );

    const input = mounted.container.querySelector(
        'input[aria-label="Spotlight a vibe"]'
    ) as HTMLInputElement;

    await React.act(async () => {
        input.focus();
        typeInto(input, "city"); // 2 local matches + the trailing vibe row
    });

    // ArrowDown twice: match[0] -> match[1] -> vibe row.
    await React.act(async () => {
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
        );
    });
    await React.act(async () => {
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
        );
    });
    await React.act(async () => {
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        );
    });
    // Flush the async vibeSearch call.
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.deepEqual(located, []);
    assert.deepEqual(vibeSearchCalls, ["city"]);

    await unmount(mounted);
});

test("Enter with zero local matches falls through to the vibe search", async () => {
    const { SpotlightSearch } = await import(
        "../../components/vibe/SpotlightSearch"
    );

    const mounted = await mount(
        React.createElement(SpotlightSearch, {
            tracks,
            onLocate: () => undefined,
            onResults: () => undefined,
            onClear: () => undefined,
        })
    );

    const input = mounted.container.querySelector(
        'input[aria-label="Spotlight a vibe"]'
    ) as HTMLInputElement;

    await React.act(async () => {
        input.focus();
        typeInto(input, "zzzznomatch");
    });

    const listbox = mounted.container.querySelector("#spotlight-listbox");
    assert.ok(listbox, "the vibe-search row alone still opens the dropdown");
    assert.doesNotMatch(listbox!.textContent ?? "", /Midnight|Aurora|Starlight/);

    await React.act(async () => {
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        );
    });
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.deepEqual(vibeSearchCalls, ["zzzznomatch"]);

    await unmount(mounted);
});

test("first Esc clears the query and closes the dropdown", async () => {
    const { SpotlightSearch } = await import(
        "../../components/vibe/SpotlightSearch"
    );
    let cleared = 0;

    const mounted = await mount(
        React.createElement(SpotlightSearch, {
            tracks,
            onLocate: () => undefined,
            onResults: () => undefined,
            onClear: () => {
                cleared += 1;
            },
        })
    );

    const input = mounted.container.querySelector(
        'input[aria-label="Spotlight a vibe"]'
    ) as HTMLInputElement;

    await React.act(async () => {
        input.focus();
        typeInto(input, "city");
    });
    assert.ok(mounted.container.querySelector("#spotlight-listbox"));

    await React.act(async () => {
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
    });

    assert.equal(input.value, "");
    assert.equal(cleared, 1);
    assert.equal(mounted.container.querySelector("#spotlight-listbox"), null);

    await unmount(mounted);
});

test("placeholder invites track/artist/vibe search", async () => {
    const { SpotlightSearch } = await import(
        "../../components/vibe/SpotlightSearch"
    );
    const mounted = await mount(
        React.createElement(SpotlightSearch, {
            tracks,
            onLocate: () => undefined,
            onResults: () => undefined,
            onClear: () => undefined,
        })
    );
    const input = mounted.container.querySelector(
        'input[aria-label="Spotlight a vibe"]'
    ) as HTMLInputElement;
    assert.equal(input.placeholder, "Search tracks, artists, or a vibe…");

    await unmount(mounted);
});
