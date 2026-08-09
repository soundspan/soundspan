/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    // The otplib v13 dependency tree (@scure/base v2, @noble/hashes v2, nested under @otplib plugins) is ESM-only.
    transformIgnorePatterns: ['/node_modules/(?!(@scure/|@noble/|@otplib/|otplib/|p-limit/|yocto-queue/))'],
    transform: {
        '^.+\\.ts$': ['ts-jest', {}],
        '^.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true } }],
    },
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    // Keep the documented low-RAM ceiling: 8 workers OOM a 23GB box; CI passes --maxWorkers explicitly.
    maxWorkers: 2,
    workerIdleMemoryLimit: '512MB',
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
};
