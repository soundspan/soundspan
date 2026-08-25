import { fixupConfigRules } from "@eslint/compat";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
    // eslint-config-next bundles plugins (eslint-plugin-react et al.) that still
    // use context APIs removed in ESLint 10; fixupConfigRules restores them via
    // the official @eslint/compat shim. Drop once eslint-config-next supports
    // ESLint 10 natively.
    ...fixupConfigRules(nextVitals),
    ...fixupConfigRules(nextTs),
    {
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                },
            ],
            // Temporary debt controls while we incrementally refactor hooks/components.
            "@typescript-eslint/no-explicit-any": "warn",
            "react/no-unescaped-entities": "warn",
            "react-hooks/preserve-manual-memoization": "warn",
            "react-hooks/set-state-in-effect": "warn",
            "react-hooks/immutability": "warn",
            // Advisory guards for the repo-wide a11y-core campaign.
            "jsx-a11y/click-events-have-key-events": "warn",
            "jsx-a11y/no-static-element-interactions": "warn",
            "jsx-a11y/interactive-supports-focus": "warn",
            // New compiler rule in eslint-plugin-react-hooks 7.1; flags Date.now()
            // in app/discover/page.tsx useMemo. Same debt bucket as the rules above.
            "react-hooks/purity": "warn",
        },
    },
    {
        files: ["tests/**"],
        rules: {
            // Tests may use any for mock shaping; runtime code keeps the warn+budget.
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
    {
        // React Query cache keys must come from the lib/queryKeys factory:
        // hand-written literals only match the factory's shapes by accident,
        // and a factory change silently orphans them (stale UI, no error).
        files: ["app/**", "components/**", "features/**", "hooks/**", "lib/**"],
        ignores: ["lib/queryKeys.ts"],
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    selector: "Property[key.name='queryKey'] > ArrayExpression",
                    message:
                        "Use the queryKeys factory from lib/queryKeys.ts instead of a hand-written key literal (GH #786).",
                },
            ],
        },
    },
    {
        files: ["components/player/hooks/**/*.{ts,tsx}"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        {
                            name: "@tanstack/react-query",
                            message:
                                "Direct React Query imports cannot be mocked by the component harness. Route the dependency through an app-alias module instead.",
                        },
                        {
                            name: "react-query",
                            message:
                                "Direct React Query imports cannot be mocked by the component harness. Route the dependency through an app-alias module instead.",
                        },
                    ],
                },
            ],
        },
    },
    {
        files: [
            "components/player/SeekSlider.tsx",
            "components/vibe/MapCanvas.tsx",
            "components/ui/Modal.tsx",
            "components/ui/ConfirmDialog.tsx",
            "components/track/TrackRow.tsx",
            "components/track/TrackList.tsx",
        ],
        rules: {
            "jsx-a11y/click-events-have-key-events": "error",
            "jsx-a11y/no-static-element-interactions": "error",
            "jsx-a11y/interactive-supports-focus": "error",
        },
    },
    // Override default ignores of eslint-config-next.
    globalIgnores([
        // Default ignores of eslint-config-next:
        ".next/**",
        "out/**",
        "build/**",
        "next-env.d.ts",
    ]),
]);

export default eslintConfig;
