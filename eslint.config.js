import js from "@eslint/js";
import { jsdoc } from "eslint-plugin-jsdoc";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "types/**",
      "out/**",
      "dist/**",
      "coverage/**",
      ".vscode-test/**"
    ]
  },
  js.configs.recommended,
  unicorn.configs.recommended,
  jsdoc({
    config: "flat/recommended-typescript-flavor-error",
    files: ["**/*.js"],
    settings: {
      preferredTypes: {
        unknown: {
          message: "Use a precise type, or disable jsdoc/check-types with a reason for untyped external data.",
          replacement: false
        }
      }
    },
    rules: {
      "jsdoc/no-undefined-types": ["error", {
        definedTypes: [
          "AbortSignal",
          "ArrayBuffer",
          "AsyncIterable",
          "ErrorOptions",
          "ReadableStream",
          "RequestInit",
          "Response",
          "Thenable",
          "TransformStream",
          "Uint8Array",
          "NodeJS.ErrnoException",
          "NodeJS.Platform"
        ]
      }],
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-param-description": "off",
      "jsdoc/require-property": "off",
      "jsdoc/require-property-description": "off",
      "jsdoc/require-returns": "off",
      "jsdoc/require-returns-check": "off",
      "jsdoc/require-returns-description": "off",
      "jsdoc/tag-lines": "off"
    }
  }),
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.nodeBuiltin,
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
      "unicorn/prefer-module": "off"
    }
  },
  {
    files: ["data/**/*.js"],
    rules: {
      "unicorn/filename-case": "off",
      "unicorn/require-module-specifiers": "off",
      "unicorn/no-empty-file": "off"
    }
  },
  {
    files: ["lib/**/[A-Z]*.js"],
    rules: {
      "unicorn/filename-case": ["error", { case: "pascalCase" }]
    }
  },
  {
    files: ["test/**/*.js"],
    rules: {
      "unicorn/consistent-function-scoping": "off"
    }
  }
];
