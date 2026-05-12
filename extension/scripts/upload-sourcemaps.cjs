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
const API = process.env.LEMU_API_URL || 'http://localhost:3000';
const TOKEN = process.env.LEMU_AUTH_TOKEN || '';

// Read version from manifest or package.json
function getVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')
    );
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

  try {
    const resp = await fetch(`${API}/api/extension/telemetry/sourcemaps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version, sourceMaps }),
    });

    if (resp.ok) {
      const data = await resp.json();
      console.log(`[upload-sourcemaps] ✅ Uploaded ${data.stored || maps.length} maps for v${version}`);
    } else {
      console.warn(`[upload-sourcemaps] ⚠️  Upload failed: ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    console.warn(`[upload-sourcemaps] ⚠️  Could not reach backend: ${err.message}`);
    console.warn('[upload-sourcemaps] Source maps saved locally in dist/ — upload manually later.');
  }

  // Remove .map files from dist so they don't ship in the extension zip
  for (const mapPath of maps) {
    fs.unlinkSync(mapPath);
  }
  console.log(`[upload-sourcemaps] Cleaned ${maps.length} .map file(s) from dist/`);
}

upload();
