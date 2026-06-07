#!/usr/bin/env node
/**
 * Upload Source Maps — Post-build script
 * Uploads .map files from dist/ to the LEMU backend for stack-trace resolution.
 *
 * Usage:
 *   node scripts/upload-sourcemaps.cjs
 *
 * Environment:
 *   LEMU_API_URL   — Backend base URL  (default: http://localhost:3000)
 *   LEMU_AUTH_TOKEN — Bearer token for auth
 */

const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist');
const API = process.env.LEMU_INGEST_URL || process.env.LEMU_API_URL || 'http://localhost:3000';
const TOKEN = process.env.LEMU_AUTH_TOKEN || '';

// Refuse to run if endpoint is plain HTTP and host isn't a loopback dev address.
(function assertSafeEndpoint() {
  let parsed;
  try {
    parsed = new URL(API);
  } catch {
    throw new Error(
      `[upload-sourcemaps] LEMU_INGEST_URL is not a valid URL: "${API}". Set LEMU_INGEST_URL to an https:// endpoint.`
    );
  }
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLoopback) {
      throw new Error(
        `[upload-sourcemaps] Refusing to upload source maps over plaintext HTTP to non-loopback host "${host}". LEMU_INGEST_URL must be https:// (or http://localhost for dev).`
      );
    }
  }
})();

// Read version from manifest or package.json
function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

// Recursively find all .map files in dist/
function findMaps(dir, maps = []) {
  if (!fs.existsSync(dir)) return maps;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findMaps(full, maps);
    } else if (entry.name.endsWith('.map')) {
      maps.push(full);
    }
  }
  return maps;
}

async function upload() {
  const version = getVersion();
  const maps = findMaps(DIST);

  if (maps.length === 0) {
    console.log('[upload-sourcemaps] No .map files found in dist/');
    return;
  }

  console.log(`[upload-sourcemaps] Found ${maps.length} source map(s) for v${version}`);

  const sourceMaps = maps.map((mapPath) => ({
    filename: path.relative(DIST, mapPath),
    content: fs.readFileSync(mapPath, 'utf-8'),
  }));

  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  let uploadOk = false;
  try {
    const resp = await fetch(`${API}/api/extension/telemetry/sourcemaps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version, sourceMaps }),
    });

    if (resp.ok) {
      uploadOk = true;
      let stored = maps.length;
      try {
        const data = await resp.json();
        stored = data.stored || maps.length;
      } catch {
        // Non-JSON 2xx is still success
      }
      console.log(`[upload-sourcemaps] ✅ Uploaded ${stored} maps for v${version}`);
    } else {
      console.error(`[upload-sourcemaps] ❌ Upload failed: ${resp.status} ${resp.statusText}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[upload-sourcemaps] ❌ Could not reach backend: ${err.message}`);
    console.error('[upload-sourcemaps] Source maps preserved in dist/ — upload manually later.');
    process.exitCode = 1;
  }

  if (uploadOk) {
    // Only delete .map files if the backend confirmed receipt; otherwise the
    // build's only symbol info would be lost forever.
    for (const mapPath of maps) {
      fs.unlinkSync(mapPath);
    }
    console.log(`[upload-sourcemaps] Cleaned ${maps.length} .map file(s) from dist/`);
  } else {
    console.warn('[upload-sourcemaps] Skipping .map cleanup because upload did not succeed.');
  }
}

upload().catch((err) => {
  console.error('[upload-sourcemaps] Unexpected error:', err.message);
  process.exitCode = 1;
});
