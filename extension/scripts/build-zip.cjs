/**
 * Build script: creates a .zip of the built extension for Chrome "Load unpacked" distribution.
 *
 * Usage:
 *   npm run build        # first, builds into dist/
 *   node scripts/build-zip.cjs
 *
 * Output: extension-v<version>.zip in the project root.
 */

const fs = require('fs');
const path = require('path');
const { zipDirectory } = require('./zip-dir.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = path.join(ROOT, 'manifest.json');

if (!fs.existsSync(DIST)) {
  console.error('Error: dist/ folder not found. Run "npm run build" first.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const version = manifest.version || '0.0.0';
const zipName = `extension-v${version}.zip`;
const zipPath = path.join(ROOT, zipName);

// Remove old zip if exists
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

try {
  const names = zipDirectory(DIST, zipPath);

  const stats = fs.statSync(zipPath);
  const sizeKB = (stats.size / 1024).toFixed(1);
  console.log(`
✓ Created ${zipName} (${sizeKB} KB, ${names.length} files)`);
  console.log(`  Load in Chrome: chrome://extensions → Load unpacked → select extracted folder`);
} catch (err) {
  console.error('Failed to create zip:', err.message);
  process.exit(1);
}
