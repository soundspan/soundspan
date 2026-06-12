import path from "node:path";

type MockDirent = {
    name: string;
    isDirectory: () => boolean;
};

type Violation = {
    filePath: string;
    line: number;
    snippet: string;
};

type VerifyNoIgnoredDataPathsModule = {
    collectFiles: (dirPath: string) => string[];
    findLine: (content: string, index: number) => number;
    scanFile: (filePath: string) => Violation[];
    main: () => void;
};

const sourceRoot = path.resolve(__dirname, "..", "..");
const backendRoot = path.resolve(sourceRoot, "..");
const ignoredPrivateBase = ["..", "data", "private"].join("/");
const ignoredGeneratedBase = ["..", "data", "generated", "files"].join("/");

const createDirent = (name: string, isDirectory: boolean): MockDirent => ({
    name,
    isDirectory: () => isDirectory,
});

const loggedText = (spy: jest.SpyInstance): string =>
    spy.mock.calls.map((call) => String(call[0])).join("\n");

describe("verifyNoIgnoredDataPaths", () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.resetModules();
        jest.clearAllMocks();
        jest.unmock("fs");
    });

    function loadScriptModule({
        directoryEntries = { [sourceRoot]: [] as MockDirent[] },
        fileContents = {},
        sourceRootIsDirectory = true,
    }: {
        directoryEntries?: Record<string, MockDirent[]>;
        fileContents?: Record<string, string>;
        sourceRootIsDirectory?: boolean;
    } = {}) {
        const readFileSync = jest.fn((filePath: string) => fileContents[filePath] ?? "");
        const readdirSync = jest.fn((dirPath: string) => directoryEntries[dirPath] ?? []);
        const statSync = jest.fn((targetPath: string) => ({
            isDirectory: () => targetPath === sourceRoot && sourceRootIsDirectory,
        }));

        jest.doMock("fs", () => ({
            readFileSync,
            readdirSync,
            statSync,
        }));

        const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(backendRoot);
        const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
        const exitSpy = jest
            .spyOn(process, "exit")
            .mockImplementation(((code?: number) => code as never) as never);

        let scriptModule!: VerifyNoIgnoredDataPathsModule;
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            scriptModule = require("../verifyNoIgnoredDataPaths") as VerifyNoIgnoredDataPathsModule;
        });

        logSpy.mockClear();
        errorSpy.mockClear();
        exitSpy.mockClear();

        return {
            scriptModule,
            readFileSync,
            readdirSync,
            statSync,
            cwdSpy,
            logSpy,
            errorSpy,
            exitSpy,
        };
    }

    it("collectFiles recursively finds all .ts and .tsx files", () => {
        const nestedDir = path.join(sourceRoot, "nested");
        const deepDir = path.join(nestedDir, "deep");
        const { scriptModule } = loadScriptModule({
            directoryEntries: {
                [sourceRoot]: [
                    createDirent("one.ts", false),
                    createDirent("view.tsx", false),
                    createDirent("nested", true),
                    createDirent("notes.md", false),
                ],
                [nestedDir]: [
                    createDirent("inner.ts", false),
                    createDirent("deep", true),
                    createDirent("skip.js", false),
                ],
                [deepDir]: [createDirent("leaf.tsx", false)],
            },
        });

        expect(scriptModule.collectFiles(sourceRoot)).toEqual([
            path.join(sourceRoot, "one.ts"),
            path.join(sourceRoot, "view.tsx"),
            path.join(nestedDir, "inner.ts"),
            path.join(deepDir, "leaf.tsx"),
        ]);
    });

    it("collectFiles skips files without .ts or .tsx extensions", () => {
        const nestedDir = path.join(sourceRoot, "nested");
        const { scriptModule } = loadScriptModule({
            directoryEntries: {
                [sourceRoot]: [
                    createDirent("config.js", false),
                    createDirent("README.md", false),
                    createDirent("nested", true),
                ],
                [nestedDir]: [
                    createDirent("component.jsx", false),
                    createDirent("styles.css", false),
                ],
            },
        });

        expect(scriptModule.collectFiles(sourceRoot)).toEqual([]);
    });

    it("findLine calculates the correct line number for a character index", () => {
        const { scriptModule } = loadScriptModule();
        const content = "first line\nsecond line\r\nthird line\nfourth line";

        expect(scriptModule.findLine(content, 0)).toBe(1);
        expect(scriptModule.findLine(content, content.indexOf("second"))).toBe(2);
        expect(scriptModule.findLine(content, content.indexOf("third"))).toBe(3);
        expect(scriptModule.findLine(content, content.indexOf("fourth"))).toBe(4);
    });

    it("scanFile detects disallowed import patterns", () => {
        const filePath = path.join(sourceRoot, "feature.ts");
        const { scriptModule } = loadScriptModule({
            fileContents: {
                [filePath]: `import helper from "${ignoredPrivateBase}/helper";\n`,
            },
        });

        expect(scriptModule.scanFile(filePath)).toEqual([
            {
                filePath: "src/feature.ts",
                line: 1,
                snippet: `from "${ignoredPrivateBase}/helper"`,
            },
        ]);
    });

    it("scanFile detects disallowed require patterns", () => {
        const filePath = path.join(sourceRoot, "loader.ts");
        const { scriptModule } = loadScriptModule({
            fileContents: {
                [filePath]: `const data = require("${ignoredPrivateBase}/cache");\n`,
            },
        });

        expect(scriptModule.scanFile(filePath)).toEqual([
            {
                filePath: "src/loader.ts",
                line: 1,
                snippet: `require("${ignoredPrivateBase}/cache")`,
            },
        ]);
    });

    it("scanFile detects disallowed join path patterns", () => {
        const filePath = path.join(sourceRoot, "paths.ts");
        const { scriptModule } = loadScriptModule({
            fileContents: {
                [filePath]: `const cachePath = join(__dirname, "${ignoredGeneratedBase}");\n`,
            },
        });

        expect(scriptModule.scanFile(filePath)).toEqual([
            {
                filePath: "src/paths.ts",
                line: 1,
                snippet: `join(__dirname, "${ignoredGeneratedBase}"`,
            },
        ]);
    });

    it("scanFile returns multiple violations when a file contains several matches", () => {
        const filePath = path.join(sourceRoot, "multi.ts");
        const { scriptModule } = loadScriptModule({
            fileContents: {
                [filePath]: [
                    `import one from "${ignoredPrivateBase}/one";`,
                    `const two = require("${ignoredPrivateBase}/two");`,
                    'const okay = require("../services/allowed");',
                    `const three = join(__dirname, "${ignoredPrivateBase}/three");`,
                    `import four from "${ignoredPrivateBase}/four";`,
                ].join("\n"),
            },
        });

        expect(scriptModule.scanFile(filePath)).toEqual([
            {
                filePath: "src/multi.ts",
                line: 1,
                snippet: `from "${ignoredPrivateBase}/one"`,
            },
            {
                filePath: "src/multi.ts",
                line: 5,
                snippet: `from "${ignoredPrivateBase}/four"`,
            },
            {
                filePath: "src/multi.ts",
                line: 2,
                snippet: `require("${ignoredPrivateBase}/two")`,
            },
            {
                filePath: "src/multi.ts",
                line: 4,
                snippet: `join(__dirname, "${ignoredPrivateBase}/three"`,
            },
        ]);
    });

    it("scanFile returns an empty array for clean files", () => {
        const filePath = path.join(sourceRoot, "clean.tsx");
        const { scriptModule } = loadScriptModule({
            fileContents: {
                [filePath]: [
                    'import { join } from "path";',
                    'import { useMemo } from "react";',
                    'const safePath = join(__dirname, "../generated/cache");',
                    'const helper = require("../services/helper");',
                ].join("\n"),
            },
        });

        expect(scriptModule.scanFile(filePath)).toEqual([]);
    });

    it("main logs success when no violations are found", () => {
        const nestedDir = path.join(sourceRoot, "nested");
        const safeTs = path.join(sourceRoot, "safe.ts");
        const safeTsx = path.join(nestedDir, "safe.tsx");
        const { scriptModule, logSpy, errorSpy, exitSpy } = loadScriptModule({
            directoryEntries: {
                [sourceRoot]: [
                    createDirent("safe.ts", false),
                    createDirent("nested", true),
                ],
                [nestedDir]: [createDirent("safe.tsx", false)],
            },
            fileContents: {
                [safeTs]: 'import { logger } from "../utils/logger";\n',
                [safeTsx]: 'export const Example = () => <div>safe</div>;\n',
            },
        });

        scriptModule.main();

        expect(logSpy).toHaveBeenCalledWith(
            "verifyNoIgnoredDataPaths: no disallowed /data/ source references found."
        );
        expect(errorSpy).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("main logs violations and exits with code 1 when matches are found", () => {
        const badFile = path.join(sourceRoot, "bad.ts");
        const { scriptModule, errorSpy, exitSpy } = loadScriptModule({
            directoryEntries: {
                [sourceRoot]: [createDirent("bad.ts", false)],
            },
            fileContents: {
                [badFile]: [
                    `import helper from "${ignoredPrivateBase}/helper";`,
                    `const cache = require("${ignoredPrivateBase}/cache");`,
                ].join("\n"),
            },
        });

        exitSpy.mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code}`);
        }) as never);

        expect(() => scriptModule.main()).toThrow("process.exit:1");
        expect(errorSpy).toHaveBeenNthCalledWith(
            1,
            "verifyNoIgnoredDataPaths: disallowed ignored-path references found:"
        );
        expect(loggedText(errorSpy)).toContain(
            `- src/bad.ts:1 -> from "${ignoredPrivateBase}/helper"`
        );
        expect(loggedText(errorSpy)).toContain(
            `- src/bad.ts:2 -> require("${ignoredPrivateBase}/cache")`
        );
    });

    it("main throws when the source root cannot be found", () => {
        const { scriptModule, statSync } = loadScriptModule();

        statSync.mockReturnValue({
            isDirectory: () => false,
        });

        expect(() => scriptModule.main()).toThrow(
            `Source root not found: ${sourceRoot}`
        );
    });
});
