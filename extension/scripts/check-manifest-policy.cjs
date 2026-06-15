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
const { execFileSync } = require('child_process');

const MANIFEST_PATH = path.join(__dirname, '..', 'manifest.json');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
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

// 8. CSP — disallow unsafe-eval/unsafe-inline, remote scripts, permissive sandbox
const BANNED_VALUES = new Set(["'unsafe-eval'", "'unsafe-inline'"]);
const SCRIPT_LIKE_DIRECTIVES = new Set([
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'default-src',
  'worker-src',
]);

function parseCsp(cspString) {
  // Returns: [{ name: 'script-src', values: ["'self'", "'unsafe-eval'"] }, ...]
  return cspString
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const tokens = d.split(/\s+/);
      return { name: tokens[0].toLowerCase(), values: tokens.slice(1) };
    });
}

function checkCspKey(label, cspString) {
  if (!cspString || typeof cspString !== 'string') return;
  const directives = parseCsp(cspString);
  for (const { name, values } of directives) {
    if (SCRIPT_LIKE_DIRECTIVES.has(name)) {
      for (const value of values) {
        // Exact-token compare — 'wasm-unsafe-eval' will NOT collide with 'unsafe-eval'
        if (BANNED_VALUES.has(value)) {
          errors.push(
            `CSP ${label}: directive ${name} contains banned value ${value} — banned by CWS MV3`
          );
        }
        // Remote scheme check: each value parsed as origin if it looks like one
        if (/^https?:\/\//i.test(value)) {
          try {
            const url = new URL(value.replace(/\/$/, ''));
            const host = url.hostname;
            const isLocal = host === 'localhost' || host === '127.0.0.1';
            if (url.protocol === 'http:' && !isLocal) {
              errors.push(
                `CSP ${label}: directive ${name} references http:// origin "${value}" — must be https://`
              );
            }
          } catch {
            errors.push(`CSP ${label}: directive ${name} has malformed origin "${value}"`);
          }
        }
      }
    }
    if (name === 'sandbox') {
      // Permissive sandbox tokens that effectively defeat sandboxing
      const PERMISSIVE = new Set([
        'allow-scripts',
        'allow-same-origin',
        'allow-top-navigation',
        'allow-popups-to-escape-sandbox',
      ]);
      const hasScripts = values.includes('allow-scripts');
      const hasSameOrigin = values.includes('allow-same-origin');
      if (hasScripts && hasSameOrigin) {
        errors.push(
          `CSP ${label}: sandbox grants both allow-scripts and allow-same-origin — defeats sandbox`
        );
      }
      for (const v of values) {
        if (!PERMISSIVE.has(v) && !/^allow-/.test(v)) {
          warnings.push(`CSP ${label}: sandbox has unknown token "${v}"`);
        }
      }
    }
  }
}

const csp = manifest.content_security_policy;
if (csp && typeof csp === 'object') {
  checkCspKey('extension_pages', csp.extension_pages);
  checkCspKey('sandbox', csp.sandbox);
}

// 8b. Monotonic version enforcement — compare with latest git tag or HEAD~1 manifest.
function parseDottedVersion(v) {
  if (!v || typeof v !== 'string') return null;
  const stripped = v.replace(/^v/i, '');
  if (!/^\d+(\.\d+){0,3}$/.test(stripped)) return null;
  return stripped.split('.').map((n) => parseInt(n, 10));
}

function compareDottedVersion(a, b) {
  // Returns 1 if a > b, -1 if a < b, 0 equal. Pads shorter with zeros.
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function readPreviousVersion() {
  // Try latest git tag first
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (tag) {
      const parsed = parseDottedVersion(tag);
      if (parsed) return { version: tag, parsed, source: `tag ${tag}` };
    }
  } catch {
    // No tags — fall through
  }
  // Fall back to HEAD~1:extension/manifest.json
  try {
    const blob = execFileSync('git', ['show', 'HEAD~1:extension/manifest.json'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const prevManifest = JSON.parse(blob);
    const parsed = parseDottedVersion(prevManifest.version);
    if (parsed) {
      return {
        version: prevManifest.version,
        parsed,
        source: 'HEAD~1:extension/manifest.json',
      };
    }
  } catch {
    // No prior commit / not in git — warn-only
  }
  return null;
}

const currentParsed = parseDottedVersion(manifest.version);
if (currentParsed) {
  const prev = readPreviousVersion();
  if (!prev) {
    warnings.push(
      'Could not determine previous version (no git tag or prior commit) — skipping monotonic version check'
    );
  } else {
    const cmp = compareDottedVersion(currentParsed, prev.parsed);
    if (cmp <= 0) {
      errors.push(
        `manifest.version "${manifest.version}" must be greater than previous version "${prev.version}" (source: ${prev.source}) — CWS rejects re-uploads`
      );
    }
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
