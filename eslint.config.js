import js from "@eslint/js";
import globals from "globals";

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "no-console": "off",
            "no-empty": ["error", { allowEmptyCatch: true }],
        },
    },
    {
        files: ["test/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
    },
    {
        ignores: ["node_modules/**", "data/**", "registry-data/**", "build-contexts/**"],
    },
];
