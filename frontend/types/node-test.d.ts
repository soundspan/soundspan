import "node:test";

declare module "node:test" {
    namespace test {
        interface MockModuleOptions {
            /**
             * Mocked module exports supported by Node.js 24.
             *
             * The `default` property becomes the default export; all other own
             * enumerable properties become named exports.
             */
            exports?: object | undefined;
        }
    }
}
