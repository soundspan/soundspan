/** @type {import('jest').Config} */
module.exports = {
    preset: "ts-jest",
    // The otplib v13 dependency tree (@scure/base v2, @noble/hashes v2, nested under @otplib plugins) is ESM-only.
    transformIgnorePatterns: [
        "/node_modules/(?!(@scure/|@noble/|@otplib/|otplib/|p-limit/|yocto-queue/))",
    ],
    transform: {
        "^.+\\.ts$": ["ts-jest", { transpilation: true, diagnostics: false }],
        "^.+\\.js$": [
            "ts-jest",
            {
                transpilation: true,
                diagnostics: false,
                tsconfig: { allowJs: true },
            },
        ],
    },
    testEnvironment: "node",
    roots: ["<rootDir>/src"],
    testMatch: ["**/__tests__/**/*.test.ts"],
    moduleFileExtensions: ["ts", "js", "json"],
    clearMocks: true,
    // Six workers completed the split-suite probe with a measured 102 MB peak worker heap; CI may override this explicitly.
    maxWorkers: 6,
    workerIdleMemoryLimit: "512MB",
    collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
};
