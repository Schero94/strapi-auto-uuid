/**
 * ESLint flat config for strapi-auto-uuid-v5 (ESLint 10).
 *
 * - @eslint/js recommended rules for every file.
 * - Admin (React, browser, ESM): JSX parsing and the eslint-plugin-react-hooks
 *   recommended preset (rules-of-hooks, exhaustive-deps and the React Compiler
 *   rules shipped in 7.x).
 * - Server and shared code (Node, ESM source bundled by @strapi/sdk-plugin):
 *   node globals and `strapi` as a readonly global.
 * - Root CommonJS entry files, tests and scripts: node globals.
 * - eslint-config-prettier last, so ESLint never fights Prettier.
 */

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

const unusedVars = [
  'error',
  {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  },
];

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', 'coverage/**', '.strapi/**']),

  {
    name: 'auto-uuid/recommended',
    files: ['**/*.{js,jsx,mjs,cjs}'],
    extends: [js.configs.recommended],
    rules: {
      'no-unused-vars': unusedVars,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },

  {
    name: 'auto-uuid/admin',
    files: ['admin/**/*.{js,jsx,mjs}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
  },

  {
    name: 'auto-uuid/server',
    files: ['server/**/*.js', 'shared/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        // Strapi provides this global to every plugin module at runtime.
        strapi: 'readonly',
      },
    },
  },

  {
    name: 'auto-uuid/commonjs-entries',
    files: ['strapi-server.js', 'strapi-admin.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  {
    name: 'auto-uuid/node-tooling',
    files: ['tests/**/*.{js,cjs,mjs}', 'scripts/**/*.{js,cjs,mjs}', '*.config.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  eslintConfigPrettier,
]);
