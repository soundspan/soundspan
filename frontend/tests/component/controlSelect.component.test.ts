import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

test("renders a select with the standard control styling and options", async () => {
    const { ControlSelect } = await import("../../components/ui/ControlSelect");
    const html = renderToStaticMarkup(
        React.createElement(
            ControlSelect,
            { value: "title", onChange: () => undefined },
            React.createElement("option", { value: "title" }, "Title"),
            React.createElement("option", { value: "author" }, "Author"),
        ),
    );
    assert.match(html, /<select/);
    assert.equal(html.match(/<option/g)?.length, 2);
    assert.match(html, /rounded-full/);
    assert.match(html, /focus:border-brand/);
    assert.match(html, /\[&amp;&gt;option\]:bg-surface-hover/);
});

test("merges a caller className after the base styling", async () => {
    const { ControlSelect } = await import("../../components/ui/ControlSelect");
    const html = renderToStaticMarkup(
        React.createElement(
            ControlSelect,
            {
                value: "",
                onChange: () => undefined,
                className: "md:min-w-[140px] truncate",
            },
            React.createElement("option", { value: "" }, "All Genres"),
        ),
    );
    assert.match(html, /md:min-w-\[140px\] truncate/);
    assert.match(html, /bg-surface-hover/);
});

test("forwards the disabled attribute", async () => {
    const { ControlSelect } = await import("../../components/ui/ControlSelect");
    const html = renderToStaticMarkup(
        React.createElement(
            ControlSelect,
            { value: "", onChange: () => undefined, disabled: true },
            React.createElement("option", { value: "" }, "n/a"),
        ),
    );
    assert.match(html, /disabled/);
});
