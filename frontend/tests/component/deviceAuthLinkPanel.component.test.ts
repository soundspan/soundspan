import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("lucide-react", {
    namedExports: {},
});

const baseProps = {
    userCode: "ABCD-1234",
    verificationUrl: "https://example.com/device",
    timeLeftSeconds: 270,
    copied: false,
    onCopyCode: () => undefined,
    onCancel: () => undefined,
    introText: "Open the authorization page.",
    pasteInstruction: "Paste this code on the page",
    signInInstruction: React.createElement("span", null, "Sign in and allow access"),
    openLinkLabel: "Open Authorization Page",
};

test("DeviceAuthLinkPanel renders device-code instructions and expiry", async () => {
    const { DeviceAuthLinkPanel } = await import(
        "../../features/settings/components/ui/DeviceAuthLinkPanel"
    );
    const html = renderToStaticMarkup(
        React.createElement(DeviceAuthLinkPanel, baseProps)
    );

    assert.match(html, /ABCD-1234/);
    assert.match(
        html,
        /<a[^>]+href="https:\/\/example\.com\/device"[^>]*>.*Open Authorization Page.*<\/a>/
    );
    assert.match(html, /Open the authorization page\./);
    assert.match(html, /Paste this code on the page/);
    assert.match(html, /Return here — this page will update automatically/);
    assert.match(html, /Expires in 4:30/);
});

test("DeviceAuthLinkPanel omits expiry when no countdown is available", async () => {
    const { DeviceAuthLinkPanel } = await import(
        "../../features/settings/components/ui/DeviceAuthLinkPanel"
    );
    const html = renderToStaticMarkup(
        React.createElement(DeviceAuthLinkPanel, {
            ...baseProps,
            timeLeftSeconds: null,
        })
    );

    assert.doesNotMatch(html, /Expires in/);
});
