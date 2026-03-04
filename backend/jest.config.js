/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    maxWorkers: 8,
    workerIdleMemoryLimit: '512MB',
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
};
