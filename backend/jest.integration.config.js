/** @type {import('jest').Config} */
module.exports = {
    preset: "ts-jest",
    transform: {
        "^.+\\.ts$": [
            "ts-jest",
            { tsconfig: "<rootDir>/tsconfig.integration.json" },
        ],
    },
    testEnvironment: "node",
    roots: ["<rootDir>/tests-integration"],
    testMatch: ["**/*.integration.test.ts"],
    setupFiles: ["<rootDir>/tests-integration/setupEnv.ts"],
    clearMocks: true,
    maxWorkers: 1,
    testTimeout: 120_000,
};
