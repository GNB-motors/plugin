// vite.config.js
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import baseManifest from './manifest.json';

/**
 * Builds the manifest for this build.
 *
 * MV3 blocks any fetch to a host absent from `host_permissions`, so a build
 * pointed at a non-default backend (dev, staging, a local tunnel) must carry
 * that origin too. Deriving it from VITE_BACKEND_BASE_URL keeps the two in
 * sync automatically — you cannot point the extension somewhere it isn't
 * permitted to call.
 *
 * With no VITE_BACKEND_BASE_URL set, the manifest is returned untouched, so
 * production builds keep exactly the committed host_permissions.
 */
function buildManifest(backendBaseUrl) {
  if (!backendBaseUrl) return baseManifest;

  let origin;
  try {
    origin = `${new URL(backendBaseUrl).origin}/*`;
  } catch {
    throw new Error(`VITE_BACKEND_BASE_URL is not a valid URL: ${backendBaseUrl}`);
  }

  const hostPermissions = baseManifest.host_permissions ?? [];
  if (hostPermissions.includes(origin)) return baseManifest;

  return { ...baseManifest, host_permissions: [...hostPermissions, origin] };
}

export default defineConfig(({ mode }) => {
  // loadEnv reads .env files and also picks up VITE_-prefixed variables already
  // present in the environment, so `VITE_BACKEND_BASE_URL=… npm run build`
  // works without referencing `process` (not a global in this lint config).
  const env = loadEnv(mode, '.', 'VITE_');
  const backendBaseUrl = env.VITE_BACKEND_BASE_URL;

  return {
    plugins: [react(), crx({ manifest: buildManifest(backendBaseUrl) })],
    build: {
      sourcemap: false,
    },
    test: {
      environment: 'node',
      globals: true,
      include: ['src/**/__tests__/**/*.test.js'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html', 'json-summary'],
        include: ['src/background/*.js'],
        exclude: ['src/background/__tests__/**'],
        thresholds: {
          statements: 80,
          branches: 70,
          functions: 85,
          lines: 80,
        },
      },
    },
  };
});
