jest.mock('../../config', () => ({ config: { port: 3006 } }));

const pkg = require('../../../package.json');

describe('openapi route sync', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test('every documented path is namespaced under /api, /health or /rest', () => {
        const { swaggerSpec } = require('../swagger');
        const keys = Object.keys(swaggerSpec.paths || {});
        const bad = keys.filter(k => !/^\/(api|health|rest)(\/|$)/.test(k));

        expect(bad).toEqual([]);
    });

    test('formerly un-prefixed endpoints are documented at their mounted /api keys', () => {
        const { swaggerSpec } = require('../swagger');
        const keys = [
            '/api/api-keys',
            '/api/api-keys/{id}',
            '/api/auth/login',
            '/api/auth/me',
            '/api/library/scan',
            '/api/lyrics/{trackId}',
            '/api/mixes',
            '/api/mixes/{id}',
            '/api/search',
            '/api/listen-together',
            '/api/listen-together/join',
        ];

        for (const key of keys) {
            expect(swaggerSpec.paths).toHaveProperty([key]);
        }
    });

    test('no un-prefixed phantom duplicates remain', () => {
        const { swaggerSpec } = require('../swagger');
        const keys = [
            '/auth/login',
            '/auth/me',
            '/api-keys',
            '/api-keys/{id}',
            '/library/scan',
            '/lyrics/{trackId}',
            '/mixes',
            '/mixes/{id}',
            '/search',
            '/listen-together',
        ];

        for (const key of keys) {
            expect(swaggerSpec.paths).not.toHaveProperty([key]);
        }
    });

    test('info.version tracks the backend package version', () => {
        const { swaggerSpec } = require('../swagger');

        expect(swaggerSpec.info.version).toBe(pkg.version);
        expect(swaggerSpec.info.version).not.toBe('1.0.0');
    });
});
