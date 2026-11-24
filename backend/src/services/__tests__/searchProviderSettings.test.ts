import {
    DEFAULT_ENABLED_SEARCH_PROVIDERS_VALUE,
    DEFAULT_SEARCH_PROVIDER_ORDER_VALUE,
    isEnabledSearchProviderList,
    isSearchProviderOrder,
    parseEnabledSearchProviders,
    parseSearchProviderOrder,
    resolveSearchProviders,
    searchProviderFields,
} from "../searchProviderSettings";

describe("search provider settings", () => {
    it("defaults to Last.fm, Deezer, TIDAL, then YouTube Music", () => {
        expect(DEFAULT_SEARCH_PROVIDER_ORDER_VALUE).toBe(
            "lastfm,deezer,tidal,youtube",
        );
        expect(parseSearchProviderOrder(undefined)).toEqual([
            "lastfm",
            "deezer",
            "tidal",
            "youtube",
        ]);
    });

    it("keeps a stored order and appends providers it does not list", () => {
        expect(parseSearchProviderOrder("deezer,bogus,lastfm,deezer")).toEqual([
            "deezer",
            "lastfm",
            "tidal",
            "youtube",
        ]);
    });

    it("enables Last.fm and Deezer by default", () => {
        expect(DEFAULT_ENABLED_SEARCH_PROVIDERS_VALUE).toBe("lastfm,deezer");
        expect([...parseEnabledSearchProviders(undefined)]).toEqual([
            "lastfm",
            "deezer",
        ]);
        expect([...parseEnabledSearchProviders("")]).toEqual([]);
        expect([...parseEnabledSearchProviders("tidal,bogus")]).toEqual([
            "tidal",
        ]);
    });

    it("validates an order only as a complete duplicate-free permutation", () => {
        expect(isSearchProviderOrder("youtube,tidal,deezer,lastfm")).toBe(true);
        expect(isSearchProviderOrder("lastfm,deezer")).toBe(false);
        expect(isSearchProviderOrder("lastfm,lastfm,tidal,youtube")).toBe(
            false,
        );
    });

    it("validates an enabled list as a duplicate-free subset", () => {
        expect(isEnabledSearchProviderList("")).toBe(true);
        expect(isEnabledSearchProviderList("tidal,lastfm")).toBe(true);
        expect(isEnabledSearchProviderList("tidal,tidal")).toBe(false);
        expect(isEnabledSearchProviderList("spotify")).toBe(false);
    });

    it("resolves enabled providers in priority order", () => {
        expect(
            resolveSearchProviders({
                searchProviderOrder: "tidal,lastfm,deezer,youtube",
                searchProvidersEnabled: "deezer,tidal",
            }),
        ).toEqual(["tidal", "deezer"]);
    });

    it("validates the system-settings API fields", () => {
        expect(
            searchProviderFields.searchProviderOrder.safeParse(
                "deezer,lastfm,tidal,youtube",
            ).success,
        ).toBe(true);
        expect(
            searchProviderFields.searchProviderOrder.safeParse("deezer")
                .success,
        ).toBe(false);
        expect(
            searchProviderFields.searchProvidersEnabled.safeParse("tidal")
                .success,
        ).toBe(true);
        expect(
            searchProviderFields.searchProvidersEnabled.safeParse("napster")
                .success,
        ).toBe(false);
    });
});
