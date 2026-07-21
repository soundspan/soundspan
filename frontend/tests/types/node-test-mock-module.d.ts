// Local augmentation for Node's `node:test` module-mocking API.
//
// Node's test runner consolidated `MockModuleOptions.defaultExport` and
// `MockModuleOptions.namedExports` into a single `exports` option (a
// `default` property represents the default export, and every other own
// enumerable property becomes a named export) — see
// https://github.com/nodejs/node/pull/61727. It ships in the Node 24 runtime
// this project targets (verified against node:24.18.0), but the installed
// `@types/node` (24.13.3) still only declares the older `cache` /
// `defaultExport` / `namedExports` trio, so every `mock.module(specifier, {
// exports: {...} })` call across tests/component fails `tsc --noEmit` with
// TS2353 even though it runs correctly.
//
// Extend the ambient type here rather than reverting ~76 call sites to the
// now-deprecated `namedExports` shape, or casting each one individually.
// Drop this file once the installed @types/node ships `exports` natively.
declare module "node:test" {
    interface MockModuleOptions {
        /**
         * Sets the mocked module's exports from a single object: a `default`
         * property becomes the default export, and every other own
         * enumerable property becomes a named export. Supported by the
         * Node 24 test runner at runtime; not yet reflected in this
         * project's installed @types/node.
         */
        exports?: object;
    }
}
