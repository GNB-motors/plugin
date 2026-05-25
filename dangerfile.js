import { danger, warn, fail, message } from 'danger';

const pr = danger.github.pr;
const modifiedFiles = danger.git.modified_files;
const createdFiles = danger.git.created_files;
const allFiles = [...modifiedFiles, ...createdFiles];

const testFiles = allFiles.filter((f) => f.includes('.test.') || f.includes('__tests__'));
const authFiles = allFiles.filter((f) =>
  f.includes('auth.js') || f.includes('backendApi.js') || f.includes('fleetedgeLink.js')
);

// ─── Rule 1: Auth changes need tests ──────────────────────────────────────────
if (authFiles.length > 0 && testFiles.length === 0) {
  fail(
    `🚨 This PR touches auth/security code (${authFiles.join(', ')}) but adds no tests. ` +
    `Auth changes MUST include tests for error paths and edge cases.`
  );
}

// ─── Rule 2: New features need tests ──────────────────────────────────────────
const newSrcFiles = createdFiles.filter((f) => f.startsWith('extension/src/') && !f.includes('__tests__'));
if (newSrcFiles.length > 0 && testFiles.length === 0) {
  warn(
    `⚠️ New source files detected (${newSrcFiles.join(', ')}) without corresponding tests. ` +
    `Please add tests or explain why none are needed in the PR template.`
  );
}

// ─── Rule 3: Code-to-test ratio gate ──────────────────────────────────────────
const codeAdditions = pr.additions || 0;
const testAdditions = testFiles.reduce((sum, f) => {
  const file = danger.git.diffForFile(f);
  if (!file || !file.added) return sum;
  if (Array.isArray(file.added)) return sum + file.added.length;
  if (typeof file.added === 'string') return sum + file.added.split('\n').length;
  return sum;
}, 0);

if (codeAdditions > 100 && testAdditions < codeAdditions * 0.15) {
  warn(
    `⚠️ PR adds ${codeAdditions} lines of code but only ~${testAdditions} lines of tests. ` +
    `That's < 15% test coverage of new code. Consider adding more tests.`
  );
}

// ─── Rule 4: PR description quality ───────────────────────────────────────────
const desc = pr.body || '';
const hasExplainer = desc.includes('## Explainer') || desc.includes('why did you choose');
if (!hasExplainer && codeAdditions > 50) {
  warn(
    `⚠️ PR is ${codeAdditions} lines but missing the "Explainer" section. ` +
    `Please explain why you chose this approach over alternatives.`
  );
}

// ─── Rule 5: Manifest changes need CWS justification ──────────────────────────
if (allFiles.includes('extension/manifest.json')) {
  const hasCwsJustification = desc.includes('CWS') || desc.includes('manifest') || desc.includes('permission');
  if (!hasCwsJustification) {
    warn(
      `⚠️ manifest.json changed but PR description lacks CWS impact justification. ` +
      `Please confirm permissions weren't added/removed without review.`
    );
  }
}

// ─── Rule 6: Large PRs should be split ────────────────────────────────────────
if (codeAdditions > 500) {
  warn(
    `🤯 This PR is ${codeAdditions} lines. Consider splitting into smaller chunks for easier review.`
  );
}

// ─── Rule 7: console.log / debugger check ─────────────────────────────────────
const logFiles = allFiles.filter((f) => {
  const diff = danger.git.diffForFile(f);
  if (!diff || !diff.added) return false;
  const added = Array.isArray(diff.added) ? diff.added.join('\n') : String(diff.added);
  return added.includes('console.log') || added.includes('debugger');
});
if (logFiles.length > 0) {
  warn(
    `⚠️ Added \`console.log\` or \`debugger\` in: ${logFiles.join(', ')}. ` +
    `Remove before merging or use the logger module.`
  );
}

// ─── Nice message if everything looks good ────────────────────────────────────
if (authFiles.length === 0 && newSrcFiles.length === 0 && codeAdditions < 100) {
  message('👍 Small, focused PR. Easy to review.');
}
