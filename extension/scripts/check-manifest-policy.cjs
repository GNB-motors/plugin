#!/usr/bin/env node
/**
 * CWS policy pre-flight check.
 *
 * Fails the build if manifest.json contains anything that would either:
 *   (a) get the extension rejected by Chrome Web Store, or
 *   (b) silently re-introduce a permission we deliberately removed in v2.0.0.
 *
 * Run via: node scripts/check-manifest-policy.cjs
 */
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'manifest.json');
const errors = [];
const warnings = [];

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error('manifest.json not found at', MANIFEST_PATH);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
} catch (err) {
  console.error('manifest.json is not valid JSON:', err.message);
  process.exit(1);
}

// 1. Banned permissions (re-added means CWS re-review + likely rejection)
const BANNED_PERMISSIONS = [
  'webRequest',
  'webRequestBlocking',
  'scripting',
  'tabs',
  'debugger',
  'management',
  'proxy',
  'cookies',
  'declarativeNetRequest',
];
const declaredPerms = manifest.permissions || [];
for (const banned of BANNED_PERMISSIONS) {
  if (declaredPerms.includes(banned)) {
    errors.push(`Banned permission "${banned}" found — was removed in v2.0.0 for CWS compliance`);
  }
}

// 2. Required permissions (we depend on these)
const REQUIRED_PERMISSIONS = ['storage', 'alarms', 'notifications'];
for (const required of REQUIRED_PERMISSIONS) {
  if (!declaredPerms.includes(required)) {
    errors.push(`Required permission "${required}" missing`);
  }
}

// 3. Host permissions — FleetEdge host must be optional, not always-on
const hostPerms = manifest.host_permissions || [];
const optionalHosts = manifest.optional_host_permissions || [];
const FLEETEDGE_HOST = 'https://fleetedge.home.tatamotors/*';

if (hostPerms.includes(FLEETEDGE_HOST)) {
  errors.push(
    'FleetEdge host must live in optional_host_permissions, not host_permissions (clean install screen)'
  );
}
if (!optionalHosts.includes(FLEETEDGE_HOST)) {
  errors.push(`Expected "${FLEETEDGE_HOST}" in optional_host_permissions`);
}

// 4. No localhost in production host_permissions
for (const host of hostPerms) {
  if (host.includes('localhost') || host.includes('127.0.0.1') || host.startsWith('http://')) {
    errors.push(`Non-HTTPS or localhost host "${host}" in host_permissions — CWS rejects this`);
  }
}

// 5. Manifest version
if (manifest.manifest_version !== 3) {
  errors.push(`manifest_version must be 3 (got ${manifest.manifest_version})`);
}

// 6. Version field present and looks like dotted numerics only
if (!manifest.version || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  errors.push(`version "${manifest.version}" must be 1-4 dot-separated integers (CWS rule)`);
}

// 7. Name and description sanity
if (!manifest.name || manifest.name.length > 75) {
  errors.push(`name must be 1–75 chars (got ${manifest.name?.length})`);
}
if (!manifest.description || manifest.description.length > 132) {
  warnings.push(
    `description should be ≤132 chars for the store short description (got ${manifest.description?.length})`
  );
}

// 8. CSP — disallow unsafe-eval, remote scripts
const csp = manifest.content_security_policy;
if (csp && typeof csp === 'object') {
  const ext = csp.extension_pages || '';
  if (ext.includes('unsafe-eval')) {
    errors.push('content_security_policy contains unsafe-eval — banned by CWS for MV3');
  }
  if (ext.includes('http://') && !ext.includes('http://localhost')) {
    errors.push('content_security_policy references http:// (must be https://)');
  }
}

// Helper: resolve a source file, falling back to public/ for Vite static assets
function resolveSource(file) {
  const direct = path.join(__dirname, '..', file);
  if (fs.existsSync(direct)) return direct;
  const inPublic = path.join(__dirname, '..', 'public', file);
  if (fs.existsSync(inPublic)) return inPublic;
  return null;
}

// 9. Content scripts — verify the two declared ones exist
const cs = manifest.content_scripts || [];
for (const entry of cs) {
  for (const js of entry.js || []) {
    if (!resolveSource(js)) {
      errors.push(`Content script "${js}" declared in manifest but file does not exist`);
    }
  }
}

// 10. Icons — verify they exist at the declared paths (or in public/)
const icons = manifest.icons || {};
for (const [size, iconPath] of Object.entries(icons)) {
  if (!resolveSource(iconPath)) {
    errors.push(`Icon (${size}px) declared as "${iconPath}" but file does not exist`);
  }
}

// Report
console.log(`Manifest policy check — version ${manifest.version}, name "${manifest.name}"`);

if (warnings.length) {
  console.log('\nWarnings:');
  for (const w of warnings) console.log(`  ⚠  ${w}`);
}

if (errors.length) {
  console.log('\nErrors:');
  for (const e of errors) console.log(`  ✗  ${e}`);
  console.log(`\n${errors.length} error(s) — build should not proceed.`);
  process.exit(1);
}

console.log('\n✓ Manifest passes CWS policy pre-flight');
