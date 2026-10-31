import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            parserOptions: {
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "no-console": "off",
            "no-empty": ["error", { allowEmptyCatch: true }],
        },
    },
    {
        files: ["test/**/*.ts", "src/**/*.test.ts"],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
        rules: {
            // tests poke at untyped JSON bodies
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
    {
        ignores: ["node_modules/**", "dist/**", "data/**", "registry-data/**", "build-contexts/**", ".claude/**"],
    },
];
