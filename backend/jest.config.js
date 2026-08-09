/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
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
