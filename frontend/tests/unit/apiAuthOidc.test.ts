import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { WithAuth } from "../../lib/api/auth";
import { ApiClientCore } from "../../lib/api/core";

GlobalRegistrator.register();

class TestAuthClient extends WithAuth(ApiClientCore) {}

const originalFetch = globalThis.fetch;

beforeEach(() => {
    localStorage.clear();
});

after(() => {
    if (originalFetch) {
        globalThis.fetch = originalFetch;
    } else {
        Reflect.deleteProperty(globalThis, "fetch");
    }
    GlobalRegistrator.unregister();
});

function mockJsonResponse(
    testContext: TestContext,
    responseBody: unknown,
): ReturnType<TestContext["mock"]["method"]> {
    return testContext.mock.method(globalThis, "fetch", async () =>
        Response.json(responseBody),
    );
}

const loginResponse = {
    token: "access-token",
    refreshToken: "refresh-token",
    user: {
        id: "user-1",
        username: "listener",
        displayName: "Listener",
        role: "user",
    },
};

test("getAuthConfig reads the public authentication capabilities", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, {
        localLoginEnabled: true,
        oidcEnabled: true,
        oidcProviderName: "Acme ID",
    });
    const client = new TestAuthClient("http://soundspan.test");

    const result = await client.getAuthConfig();

    assert.deepEqual(result, {
        localLoginEnabled: true,
        oidcEnabled: true,
        oidcProviderName: "Acme ID",
    });
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(
        String(fetchMock.mock.calls[0].arguments[0]),
        "http://soundspan.test/api/auth/config",
    );
});

test("startOidcLink requests a JSON navigation response", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, {
        redirectUrl: "https://idp.example/authorize?state=state-1",
    });
    const client = new TestAuthClient("http://soundspan.test");

    const result = await client.startOidcLink();

    assert.equal(
        result.redirectUrl,
        "https://idp.example/authorize?state=state-1",
    );
    const request = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(request.method, "POST");
    assert.equal(request.body, JSON.stringify({ responseMode: "json" }));
});

test("identity and app-password methods use the authenticated auth routes", async (testContext) => {
    const responses = [
        { identities: [] },
        { message: "Identity unlinked" },
        { appPasswords: [] },
        {
            appPassword: {
                id: "app-1",
                displayName: "Phone",
                createdAt: "2026-08-15T12:00:00.000Z",
                lastUsedAt: null,
                secret: "ssap_secret",
            },
        },
        { message: "App password revoked" },
    ];
    const fetchMock = testContext.mock.method(globalThis, "fetch", async () =>
        Response.json(responses.shift()),
    );
    const client = new TestAuthClient("http://soundspan.test");

    await client.getExternalIdentities();
    await client.unlinkExternalIdentity("identity/1");
    await client.listAppPasswords();
    const created = await client.createAppPassword("Phone");
    await client.revokeAppPassword("app/1");

    assert.equal(created.appPassword.secret, "ssap_secret");
    assert.deepEqual(
        fetchMock.mock.calls.map((call) => String(call.arguments[0])),
        [
            "http://soundspan.test/api/auth/identities",
            "http://soundspan.test/api/auth/identities/identity%2F1",
            "http://soundspan.test/api/auth/app-passwords",
            "http://soundspan.test/api/auth/app-passwords",
            "http://soundspan.test/api/auth/app-passwords/app%2F1",
        ],
    );
    const createRequest = fetchMock.mock.calls[3].arguments[1] as RequestInit;
    assert.equal(createRequest.method, "POST");
    assert.equal(createRequest.body, JSON.stringify({ displayName: "Phone" }));
});

test("exchangeOidcCode stores both login tokens", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, loginResponse);
    const client = new TestAuthClient("http://soundspan.test");

    const user = await client.exchangeOidcCode("exchange-code");

    assert.deepEqual(user, loginResponse.user);
    assert.equal(localStorage.getItem("auth_token"), "access-token");
    assert.equal(localStorage.getItem("refresh_token"), "refresh-token");
    const request = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(request.method, "POST");
    assert.equal(request.credentials, "include");
    assert.equal(request.body, JSON.stringify({ code: "exchange-code" }));
});

test("confirmOidcLink stores tokens after credential confirmation", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, loginResponse);
    const client = new TestAuthClient("http://soundspan.test");

    const result = await client.confirmOidcLink({
        linkToken: "link-token",
        password: "correct horse battery staple",
        twoFactorToken: "123456",
    });

    assert.deepEqual(result, loginResponse.user);
    assert.equal(localStorage.getItem("auth_token"), "access-token");
    assert.equal(localStorage.getItem("refresh_token"), "refresh-token");
    const request = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(request.credentials, "include");
    assert.equal(
        request.body,
        JSON.stringify({
            linkToken: "link-token",
            password: "correct horse battery staple",
            twoFactorToken: "123456",
        }),
    );
});

test("confirmOidcLink returns a 2FA challenge without storing tokens", async (testContext) => {
    mockJsonResponse(testContext, {
        requires2FA: true,
        message: "2FA token required",
    });
    const client = new TestAuthClient("http://soundspan.test");

    const result = await client.confirmOidcLink({
        linkToken: "link-token",
        password: "correct horse battery staple",
    });

    assert.deepEqual(result, {
        requires2FA: true,
        message: "2FA token required",
    });
    assert.equal(localStorage.getItem("auth_token"), null);
    assert.equal(localStorage.getItem("refresh_token"), null);
});

test("redeemOidcInvite stores tokens after successful provisioning", async (testContext) => {
    const fetchMock = mockJsonResponse(testContext, loginResponse);
    const client = new TestAuthClient("http://soundspan.test");

    const user = await client.redeemOidcInvite({
        inviteToken: "invite-token",
        inviteCode: "INVITE42",
    });

    assert.deepEqual(user, loginResponse.user);
    assert.equal(localStorage.getItem("auth_token"), "access-token");
    assert.equal(localStorage.getItem("refresh_token"), "refresh-token");
    const request = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(request.credentials, "include");
    assert.equal(
        request.body,
        JSON.stringify({
            inviteToken: "invite-token",
            inviteCode: "INVITE42",
        }),
    );
});
