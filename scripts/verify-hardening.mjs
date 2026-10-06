/**
 * Regression check for the hardening fixes found by the 2026-10 code audit.
 *
 * These are the pure parts of the fixes, so they need neither a working copy
 * nor a browser:
 *   1. `resolveTargetAbs` must pass repository URLs through untouched — the
 *      defect was that `svn://host/repo` was resolved against the workspace
 *      into `C:\…\svn:\host\repo`, breaking svn_list / svn_cat / svn_export /
 *      svn_copy / svn_move / svn_mkdir for every URL;
 *   2. `positionalArg` must refuse operands that svn's getopt would read as
 *      OPTIONS (`svn propget --version …` is accepted as an option by svn
 *      itself, so a caller-supplied `--config-dir=` could execute commands via
 *      diff-cmd/editor-cmd);
 *   3. `prepareForCommit` reports the new `failed` list, so a repair that did
 *      not happen is never reported as done.
 *
 * Usage:  node scripts/verify-hardening.mjs
 * Exit code 0 = all checks passed.
 */
import { __test } from '../lib/index.js';

const { resolveTargetAbs, positionalArg, prepareForCommit } = __test;

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('  FAIL ' + label + (detail ? ` — ${detail}` : '')); }
}
function throws(fn) {
  try { fn(); return null; } catch (error) { return error; }
}

const cwd = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';

// ---------------------------------------------------------- 1) URL passthrough
console.log('repository URLs are never resolved as filesystem paths:');
for (const url of [
  'svn://svn.example.com/repo/trunk',
  'svn+ssh://user@host/repo/trunk',
  'http://host/svn/repo',
  'https://host/svn/repo',
  'file:///C:/repo/trunk',
]) {
  check(resolveTargetAbs(url, cwd) === url, `passthrough ${url}`, resolveTargetAbs(url, cwd));
}
console.log('local paths still resolve as before:');
const abs = process.platform === 'win32' ? 'C:\\other\\file.txt' : '/other/file.txt';
check(resolveTargetAbs(abs, cwd) === abs, 'an absolute path passes through');
check(resolveTargetAbs('sub/file.txt', cwd) === (process.platform === 'win32' ? 'C:\\work\\proj\\sub\\file.txt' : '/work/proj/sub/file.txt'), 'a relative path resolves against the base');
check(resolveTargetAbs(undefined, cwd) === cwd, 'a missing value falls back to the base');
check(resolveTargetAbs('svn://host/repo', undefined) === 'svn://host/repo', 'a URL survives a missing base');
// The bug shape: never a Windows path that embeds the URL.
check(!resolveTargetAbs('svn://svn.svnbucket.com/smtc/x', cwd).includes('svn:\\'), 'the URL is not folded into a windows path');

// --------------------------------------------------- 2) option-injection guard
console.log('positional operands that look like svn options are refused:');
for (const bad of ['--config-dir=C:\\evil', '-R', '--targets=C:\\evil.txt', '-', '--diff-cmd=calc']) {
  const error = throws(() => positionalArg(bad, 'name'));
  check(error !== null, `refused ${JSON.stringify(bad)}`, 'accepted');
  if (error !== null) check(error.status === 400, `  …with a 400 (${JSON.stringify(bad)})`, String(error.status));
}
console.log('legitimate operands still pass:');
for (const good of ['svn:ignore', 'svn://host/repo/trunk', 'trunk', 'branches/feat-1', 'a/b/c.txt']) {
  check(positionalArg(good, 'source') === good, `accepted ${JSON.stringify(good)}`);
}
const missing = throws(() => positionalArg('', 'url'));
check(missing !== null && /required/.test(missing.message), 'an empty operand reports "required"');

// ------------------------------------------------- 3) commit-repair reporting
console.log('prepareForCommit reports the new failure channel:');
// No working copy here: the status probe fails per directory and the paths are
// treated as unversioned/missing, which is enough to assert the RESULT SHAPE —
// the behaviour against a real working copy lives in verify-settings-host.mjs.
const prepared = await prepareForCommit(cwd, []);
check(Array.isArray(prepared.added), 'added is an array');
check(Array.isArray(prepared.deleted), 'deleted is an array');
check(Array.isArray(prepared.skipped), 'skipped is an array');
check(Array.isArray(prepared.failed), 'failed is an array (a repair that did not happen is never reported as done)');

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nALL HARDENING CHECKS PASSED');
