import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Two Vitest projects (https://vitest.dev/guide/projects, Vitest 5.1):
 * - `unit`: server, shared and admin helper tests in Node.
 * - `admin`: the admin StrictMode harness (tests/admin) in jsdom, with every dependency inlined
 *   so Vite resolves and transforms the Strapi admin, the Design System and their CommonJS
 *   dependencies the way the admin build does.
 */
export default defineConfig({
  test: {
    clearMocks: true,
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.js'],
        },
      },
      {
        extends: true,
        // The admin sources use the automatic JSX runtime (no `import React`), as in the
        // Strapi admin build (@vitejs/plugin-react).
        esbuild: { jsx: 'automatic' },
        resolve: {
          alias: {
            'socket.io-client': fileURLToPath(
              new URL('./tests/admin/harness/fake-socket.mjs', import.meta.url)
            ),
          },
        },
        test: {
          name: 'admin',
          environment: 'jsdom',
          environmentOptions: { jsdom: { url: 'http://localhost:1337/admin/' } },
          include: ['tests/admin/**/*.test.jsx'],
          setupFiles: ['./tests/admin/harness/setup.mjs'],
          server: { deps: { inline: true } },
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
