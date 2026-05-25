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

// Files / patterns to skip
const SKIP_PATTERNS = [
  /\bnode_modules\b/,
  /\b__tests__\b/, // tests legitimately contain fixture tokens
  /\.test\.js$/,
  /\.spec\.js$/,
];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP_PATTERNS.some((p) => p.test(full))) continue;
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(jsx?|html|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC_DIR);
console.log(`Scanning ${files.length} source files for security issues...`);

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  for (const [pattern, severity, label] of PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      // Find the line number
      const offset = m.index;
      let lineNo = 1;
      let cum = 0;
      for (let i = 0; i < lines.length; i++) {
        if (cum + lines[i].length + 1 > offset) {
          lineNo = i + 1;
          break;
        }
        cum += lines[i].length + 1;
      }
      const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
      issues.push({ severity, file: rel, line: lineNo, label, snippet: m[0].slice(0, 60) });
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
