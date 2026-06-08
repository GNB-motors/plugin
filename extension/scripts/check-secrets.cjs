#!/usr/bin/env node
/**
 * Source secrets pre-flight check.
 *
 * Scans `src/` for things that should never be committed:
 *   - Hardcoded API keys / tokens / passwords
 *   - eval() / new Function() — banned by CWS MV3
 *   - innerHTML assignment from non-literal — XSS risk
 *   - Remote script imports
 *
 * Run via: node scripts/check-secrets.cjs
 */
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const issues = [];

// Patterns that should not appear in source. Format: [regex, severity, label]
const PATTERNS = [
  // Hardcoded secrets — naive but catches the obvious mistakes
  [
    /(?:api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi,
    'error',
    'Possible hardcoded secret',
  ],
  [/Bearer\s+[A-Za-z0-9_\-.]{30,}/g, 'error', 'Hardcoded Bearer token'],
  [/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}/g, 'error', 'Hardcoded JWT'],
  // AWS-style keys
  [/AKIA[0-9A-Z]{16}/g, 'error', 'AWS access key id'],
  // Google API key prefix
  [/AIza[0-9A-Za-z\-_]{35}/g, 'error', 'Google API key'],

  // CWS / MV3 banned patterns
  [/\beval\s*\(/g, 'error', 'eval() — banned by CWS MV3'],
  [/new\s+Function\s*\(/g, 'error', 'new Function() — banned by CWS MV3'],

  // XSS risk
  [
    /\.innerHTML\s*=\s*(?!['"`]\s*['"`])/g,
    'warning',
    'innerHTML assignment — verify input is sanitized',
  ],
  [/document\.write\s*\(/g, 'error', 'document.write() — banned in MV3 service workers'],

  // Remote code loading
  [/import\s*\(\s*['"`]https?:/g, 'error', 'Dynamic import from URL — CWS bans remote code'],
  [/<script[^>]+src\s*=\s*['"]https?:/gi, 'error', '<script src> with remote URL'],
];

// Directory segments to skip entirely
const SKIP_DIRS = new Set(['node_modules', '__tests__']);
// Filename patterns to skip (test fixtures)
const SKIP_FILE_PATTERNS = [/\.test\.(jsx?|tsx?|mjs|cjs)$/, /\.spec\.(jsx?|tsx?|mjs|cjs)$/];
// Extensions to scan (warn-only for .env*)
const SCAN_EXTENSIONS = /\.(jsx?|tsx?|mjs|cjs|json|html|css)$/;
const ENV_FILE_PATTERN = /^\.env(\..+)?$/;

function shouldSkipDir(full) {
  const segs = full.split(path.sep);
  return segs.some((s) => SKIP_DIRS.has(s));
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (SKIP_FILE_PATTERNS.some((p) => p.test(entry.name))) continue;
    if (shouldSkipDir(full)) continue;
    if (SCAN_EXTENSIONS.test(entry.name) || ENV_FILE_PATTERN.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Shannon entropy in bits/char
function shannonEntropy(str) {
  if (!str) return 0;
  const freq = Object.create(null);
  for (const c of str) freq[c] = (freq[c] || 0) + 1;
  const len = str.length;
  let h = 0;
  for (const k in freq) {
    const p = freq[k] / len;
    h -= p * Math.log2(p);
  }
  return h;
}

// Match long string literals (single/double/backtick) — basic, no nesting.
const STRING_LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\\r\n]){32,})\1/g;
const ENTROPY_THRESHOLD = 4.0;
// Skip strings that obviously aren't secrets (URLs, paths, sentences with spaces)
function looksLikeNonSecret(s) {
  if (/\s/.test(s)) return true; // sentences/paths with spaces
  if (/\$\{/.test(s)) return true; // template literal with interpolation — not a static secret
  if (/^https?:\/\//i.test(s)) return true;
  if (/^data:/i.test(s)) return true;
  if (/^\//.test(s)) return true; // absolute paths / regex
  if (/^[<>]/.test(s)) return true;
  return false;
}

const files = walk(SRC_DIR);
console.log(`Scanning ${files.length} source files for security issues...`);

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  const basename = path.basename(file);
  const isEnv = ENV_FILE_PATTERN.test(basename);
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');

  function lineOf(offset) {
    let cum = 0;
    for (let i = 0; i < lines.length; i++) {
      if (cum + lines[i].length + 1 > offset) return i + 1;
      cum += lines[i].length + 1;
    }
    return lines.length;
  }

  for (const [pattern, severity, label] of PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    let lastIdx = -1;
    while ((m = pattern.exec(content)) !== null) {
      // Guard against zero-length matches infinite-looping
      if (m.index === lastIdx && m[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      lastIdx = m.index;
      const lineNo = lineOf(m.index);
      const effSev = isEnv ? 'warning' : severity;
      issues.push({ severity: effSev, file: rel, line: lineNo, label, snippet: m[0].slice(0, 60) });
    }
  }

  // Entropy backup heuristic for unknown-shape obfuscated keys (skip .env*, .json blobs are noisy)
  if (!isEnv && !/\.(json|html|css)$/.test(basename)) {
    STRING_LITERAL_RE.lastIndex = 0;
    let m;
    while ((m = STRING_LITERAL_RE.exec(content)) !== null) {
      const body = m[2];
      if (body.length < 32) continue;
      if (looksLikeNonSecret(body)) continue;
      const h = shannonEntropy(body);
      if (h >= ENTROPY_THRESHOLD) {
        const lineNo = lineOf(m.index);
        issues.push({
          severity: 'warning',
          file: rel,
          line: lineNo,
          label: `High-entropy string literal (entropy=${h.toFixed(2)}) — possible obfuscated secret`,
          snippet: m[0].slice(0, 60),
        });
      }
    }
  }
}

const errors = issues.filter((i) => i.severity === 'error');
const warnings = issues.filter((i) => i.severity === 'warning');

if (warnings.length) {
  console.log('\nWarnings:');
  for (const w of warnings)
    console.log(`  ⚠  ${w.file}:${w.line} — ${w.label}\n      ${w.snippet}`);
}

if (errors.length) {
  console.log('\nErrors:');
  for (const e of errors) console.log(`  ✗  ${e.file}:${e.line} — ${e.label}\n      ${e.snippet}`);
  console.log(`\n${errors.length} security issue(s) found — fix before committing.`);
  process.exit(1);
}

console.log(
  `\n✓ Source clean — no hardcoded secrets or banned patterns (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`
);
