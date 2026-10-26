/**
 * Regression check for the panel's built-in directory browser: the read-only
 * `POST /svn/api/list-dir` endpoint (`api.listDir`).
 *
 * What it pins down:
 *   1. the response shape (`path` / `parent` / `entries[].{name,path,isDir,isWc,hasSvn}`
 *      / `truncated` / `total`), and that `parent` is a listable directory while
 *      a filesystem root reports `parent: null`;
 *   2. only absolute paths are accepted — a relative path, a missing directory
 *      and a regular file are all refused with a 400 (`bad-request`);
 *   3. directories sort before files, each group case-insensitively by name;
 *   4. more than 500 listable entries are truncated: `truncated: true`,
 *      `entries.length === 500`, `total` still reports the real count;
 *   5. `.svn` is NEVER listed, other dot-entries only with `showHidden: true`;
 *   6. `hasSvn` / `isWc` distinguish an independent checkout root (hasSvn) from
 *      a project subdirectory inside that checkout (isWc only), and a file is
 *      neither;
 *   7. a symbolic link is not followed: it is listed as a non-directory and
 *      never exposes the working copy behind it;
 *   8. `readOnly: true` is not refused (list-dir is a read, not a write).
 *
 * Usage:  node scripts/verify-list-dir.mjs
 * Exit code 0 = all checks passed, 1 = at least one check failed,
 *           2 = svn/svnadmin was not available, so the checkout fixture was
 *               replaced by a synthetic `.svn` marker (everything else ran).
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, lstatSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const SVN = process.platform === 'win32' ? 'svn.exe' : 'svn';
const SVNADMIN = process.platform === 'win32' ? 'svnadmin.exe' : 'svnadmin';

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else {
    failures++;
    console.error('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}

function run(binary, args, opts = {}) {
  return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
/** Nearest ancestor (or self) holding a `.svn` directory — mirrors wcRootOf. */
function checkoutOf(target) {
  let dir = path.resolve(target);
  for (;;) {
    if (lstatSync(path.join(dir, '.svn'), { throwIfNoEntry: false })) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

// ------------------------------------------------------------- prerequisites
let svnReady = true;
try {
  run(SVN, ['--version', '--quiet']);
  run(SVNADMIN, ['--version', '--quiet']);
} catch {
  svnReady = false;
}

// ---------------------------------------------------------------- fixture
const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-svn-listdir-'));
const ambient = checkoutOf(root);
if (ambient !== undefined) {
  console.warn('  warn  the temporary directory sits inside a working copy (' + ambient + ');'
    + ' the "outside any checkout" assertions are not meaningful here');
}

const wc = path.join(root, 'wc');
const project = path.join(wc, 'proj');
const plainDir = path.join(root, 'plain-dir');
const emptyDir = path.join(root, 'empty');
const bigDir = path.join(root, 'big');
const linkPath = path.join(root, 'link-to-wc');

for (const name of ['Zzz-dir', 'aaa-dir', 'Bbb-dir', '.hidden-dir']) {
  mkdirSync(path.join(root, name), { recursive: true });
}
mkdirSync(plainDir);
mkdirSync(emptyDir);
mkdirSync(bigDir);
for (const name of ['Aaa.txt', 'zzz.txt', 'm.txt', '.hidden.txt']) {
  writeFileSync(path.join(root, name), 'x\n');
}

if (svnReady) {
  const repo = path.join(root, 'repo');
  run(SVNADMIN, ['create', repo]);
  run(SVN, ['checkout', fileUrl(repo), wc, '--non-interactive']);
} else {
  // The endpoint classifies by the filesystem alone (`wcRootOf` stats `.svn`),
  // so a synthetic marker exercises hasSvn/isWc exactly like a real checkout.
  console.warn('  warn  svn/svnadmin are not available; using a synthetic .svn marker');
  mkdirSync(wc, { recursive: true });
  mkdirSync(path.join(wc, '.svn'), { recursive: true });
}
mkdirSync(project, { recursive: true });
mkdirSync(path.join(project, 'sub'));
writeFileSync(path.join(wc, 'plain.txt'), 'p\n');

console.log('fixture: ' + root);
console.log('checkout: ' + wc + (svnReady ? '' : ' (synthetic .svn)'));

// ------------------------------------------------------------ api harness
function makeCall() {
  let handler;
  const ctx = {
    tools: { register() {} },
    webServer: { register(o) { handler = o.handler; } },
    sessions: { get: () => ({ header: { cwd: root } }) },
    agents: {},
    llm: {},
    effect(fn) { return fn(); },
    inject() { return { dispose() {} }; },
  };
  apply(ctx, {});
  return async function call(method, payload) {
    const req = {
      method: 'POST',
      url: `/svn/api/${method}`,
      headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
      on(ev, fn) {
        if (ev === 'data') fn(Buffer.from(JSON.stringify(payload ?? {})));
        if (ev === 'end') fn();
        return this;
      },
      destroy() {},
    };
    return await new Promise((resolve, reject) => {
      const res = {
        status: 0,
        writeHead(s) { this.status = s; },
        end(b) {
          let parsed;
          try {
            parsed = JSON.parse(b);
          } catch {
            reject(Object.assign(new Error('non-JSON response: ' + String(b).slice(0, 200)), { status: this.status }));
            return;
          }
          if (this.status !== 200 || parsed.ok !== true) {
            const error = new Error(parsed?.error?.message || String(b).slice(0, 200));
            error.status = this.status;
            error.code = parsed?.error?.code;
            reject(error);
          } else {
            resolve(parsed.value);
          }
        },
      };
      handler(req, res).catch(reject);
    });
  };
}

const call = makeCall();
async function callFails(method, payload) {
  try { return { failed: false, value: await call(method, payload) }; }
  catch (error) { return { failed: true, message: error.message, status: error.status, code: error.code }; }
}
function entryOf(listing, name) {
  return listing.entries.find((e) => e.name === name);
}

// ------------------------------------------- 1) shape, parent, listing rules
console.log('response shape and ordering:');
const base = await call('list-dir', { path: root });
check(samePath(base.path, root), 'path is the requested directory', base.path);
check(base.parent !== null && samePath(base.parent, path.dirname(root)),
  'parent is the enclosing directory', String(base.parent));
check(Array.isArray(base.entries) && base.entries.length > 0, 'entries is a non-empty array');
check(base.entries.every((e) => typeof e.name === 'string' && typeof e.path === 'string'
  && typeof e.isDir === 'boolean' && typeof e.isWc === 'boolean' && typeof e.hasSvn === 'boolean'),
  'every entry carries name / path / isDir / isWc / hasSvn');
check(base.entries.every((e) => samePath(path.join(base.path, e.name), e.path)),
  'entry paths are the directory joined with the name');
check(base.truncated === false, 'a small directory is not truncated');
check(base.total === base.entries.length, 'total matches the entry count', String(base.total));
check(!base.entries.some((e) => e.name === '.svn'), '.svn is never listed');
check(!base.entries.some((e) => e.name.startsWith('.')), 'dot entries are hidden by default');

const firstFile = base.entries.findIndex((e) => !e.isDir);
check(firstFile > 0 && base.entries.slice(firstFile).every((e) => !e.isDir),
  'directories are listed before files');
check(base.entries.findIndex((e) => e.name === 'aaa-dir') < base.entries.findIndex((e) => e.name === 'Zzz-dir'),
  'directory names sort case-insensitively (aaa-dir before Zzz-dir)',
  base.entries.map((e) => e.name).join(','));
check(base.entries.findIndex((e) => e.name === 'Aaa.txt') < base.entries.findIndex((e) => e.name === 'zzz.txt'),
  'file names sort case-insensitively (Aaa.txt before zzz.txt)',
  base.entries.map((e) => e.name).join(','));

const fsRoot = path.parse(root).root;
const rootListing = await call('list-dir', { path: fsRoot });
check(rootListing.parent === null, 'a filesystem root reports parent: null', String(rootListing.parent));
check(samePath(rootListing.path, fsRoot), 'the filesystem root is returned normalised', rootListing.path);

const parentListing = await call('list-dir', { path: base.parent });
check(samePath(parentListing.path, base.parent), 'parent is itself listable', parentListing.path);

const empty = await call('list-dir', { path: emptyDir });
check(empty.entries.length === 0, 'an empty directory reports no entries', String(empty.entries.length));
check(empty.parent !== null && samePath(empty.parent, root), 'an empty directory still reports its parent');

const trailing = await call('list-dir', { path: root + path.sep });
check(samePath(trailing.path, root), 'a trailing separator is normalised away', trailing.path);

// ------------------------------------------------- 2) 400 on bad arguments
console.log('absolute + directory required (400):');
const relative = await callFails('list-dir', { path: 'relative/dir' });
check(relative.failed === true, 'a relative path is refused');
check(relative.status === 400 && relative.code === 'bad-request',
  'the refusal is a 400 bad-request', String(relative.status) + '/' + String(relative.code));
check(/绝对路径/.test(relative.message || ''), 'the refusal says an absolute path is required', relative.message);

const missingPath = await callFails('list-dir', { path: path.join(root, 'no-such-dir') });
check(missingPath.failed === true && missingPath.status === 400, 'a missing directory is a 400', String(missingPath.status));
check(/目录不存在/.test(missingPath.message || ''), 'the refusal says the directory does not exist', missingPath.message);

const notDir = await callFails('list-dir', { path: path.join(root, 'Aaa.txt') });
check(notDir.failed === true && notDir.status === 400, 'a regular file is a 400', String(notDir.status));
check(/不是目录/.test(notDir.message || ''), 'the refusal says it is not a directory', notDir.message);

const noPath = await callFails('list-dir', {});
check(noPath.failed === true && noPath.status === 400, 'a missing path is a 400', String(noPath.status));

// ------------------------------------------------------ 3) hidden filtering
console.log('showHidden:');
const shown = await call('list-dir', { path: root, showHidden: true });
check(shown.entries.some((e) => e.name === '.hidden-dir'), 'showHidden:true lists dot directories');
check(shown.entries.some((e) => e.name === '.hidden.txt'), 'showHidden:true lists dot files');
check(!shown.entries.some((e) => e.name === '.svn'), '.svn stays hidden even with showHidden:true');

// -------------------------------------------- 4) hasSvn / isWc semantics
console.log('hasSvn / isWc (checkout root vs project subdirectory):');
const rootEntries = await call('list-dir', { path: root });
const wcEntry = entryOf(rootEntries, 'wc');
check(wcEntry !== undefined, 'the checkout is listed');
check(wcEntry.isDir === true, 'the checkout is a directory');
check(wcEntry.hasSvn === true, 'the checkout root has its own .svn (hasSvn)');
check(wcEntry.isWc === true, 'the checkout root is a working copy (isWc)');

const plainEntry = entryOf(rootEntries, 'plain-dir');
check(plainEntry !== undefined && plainEntry.hasSvn === false && plainEntry.isWc === false,
  'a directory outside any checkout is neither hasSvn nor isWc',
  JSON.stringify({ hasSvn: plainEntry?.hasSvn, isWc: plainEntry?.isWc }));

const wcListing = await call('list-dir', { path: wc });
const projectEntry = entryOf(wcListing, 'proj');
check(projectEntry !== undefined, 'a project subdirectory is listed');
check(projectEntry.isDir === true, 'the project subdirectory is a directory');
check(projectEntry.hasSvn === false, 'a project subdirectory is not a checkout root (no hasSvn)');
check(projectEntry.isWc === true, 'a project subdirectory inside a checkout is isWc');
check(!wcListing.entries.some((e) => e.name === '.svn'), "the checkout's .svn is not listed");

// A level deeper: the subdirectory is still inside the checkout, but it is the
// listed directory that carries the ancestry, not the entry itself.
const projectListing = await call('list-dir', { path: project });
const subEntry = entryOf(projectListing, 'sub');
check(subEntry !== undefined && subEntry.isWc === true, 'a nested subdirectory is still isWc');
check(subEntry?.hasSvn === false, 'a nested subdirectory has no .svn of its own');

const fileEntry = entryOf(wcListing, 'plain.txt');
check(fileEntry !== undefined && fileEntry.isDir === false, 'a file is listed as a non-directory');
check(fileEntry.hasSvn === false && fileEntry.isWc === false, 'a file is neither hasSvn nor isWc');

// ------------------------------------------------------------ 5) truncation
console.log('truncation at 500 entries:');
const BIG = 520;
for (let i = 0; i < BIG; i++) {
  mkdirSync(path.join(bigDir, 'd' + String(i).padStart(3, '0')));
}
const big = await call('list-dir', { path: bigDir });
check(big.truncated === true, 'more than 500 entries reports truncated:true');
check(big.entries.length === 500, 'exactly 500 entries are returned', String(big.entries.length));
check(big.total === BIG, 'total counts every listable entry', String(big.total));
check(big.entries[0]?.name === 'd000', 'the sorted head is kept, not an arbitrary 500', String(big.entries[0]?.name));
check(big.entries.every((e) => e.isDir === true), 'every entry of the 520-directory fixture is a directory');

// ---------------------------------------------------------------- 6) links
console.log('symbolic links are not followed:');
// Windows needs Developer Mode or an elevated shell for a real symlink; a
// junction is the usual fallback and is reported as a link by lstat as well.
let linkMade = false;
for (const type of ['junction', 'dir', 'file']) {
  try {
    symlinkSync(wc, linkPath, type);
  } catch {
    continue;
  }
  if (lstatSync(linkPath).isSymbolicLink()) { linkMade = true; break; }
  rmSync(linkPath, { recursive: true, force: true });
}
if (!linkMade) console.log('  skip  could not create a directory link; link handling is not exercised');
if (linkMade) {
  const linkedListing = await call('list-dir', { path: root });
  const linkEntry = entryOf(linkedListing, 'link-to-wc');
  check(linkEntry !== undefined, 'the link is listed');
  check(linkEntry.isDir === false, 'a link to a directory is NOT reported as a directory (never followed)');
  check(linkEntry.hasSvn === false && linkEntry.isWc === false,
    'the link does not expose the working copy behind it',
    JSON.stringify({ hasSvn: linkEntry.hasSvn, isWc: linkEntry.isWc }));
  const viaLink = await call('list-dir', { path: linkPath });
  check(samePath(viaLink.path, wc), 'a request through a link resolves to the real directory (realpath)', viaLink.path);
}

// ------------------------------------------------------------- 7) readOnly
console.log('read-only mode:');
const readOnlyCall = await callFails('list-dir', { path: root, readOnly: true });
check(readOnlyCall.failed === false, 'readOnly:true is not refused (list-dir is a read)', readOnlyCall.message);
check(Array.isArray(readOnlyCall.value?.entries), 'readOnly:true still returns a listing');

// ------------------------------------------------------------- teardown
// A junction/symlink to a directory inside the fixture makes a recursive
// remove fail on Windows (EBUSY/EPERM), so unlink the link first.
if (linkMade) {
  try { rmSync(linkPath, { force: true }); } catch { /* it may already be gone */ }
}
// `svnadmin create` marks a few repository files read-only (repo/format,
// repo/db/format, …), and fs.rmSync does NOT clear that attribute on Windows —
// it just throws EPERM. Unlock the tree and retry once; if that still fails,
// only warn, because a leftover temp directory must not fail the run.
function unlockTree(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    try {
      if (entry.isDirectory() && !entry.isSymbolicLink()) unlockTree(child);
      chmodSync(child, 0o777);
    } catch { /* best effort */ }
  }
  try { chmodSync(dir, 0o777); } catch { /* best effort */ }
}
try {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    unlockTree(root);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} catch (error) {
  console.warn('  warn  could not remove the temporary fixture: ' + root
    + ' (' + (error.code || error.message) + ')');
}

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
if (!svnReady) {
  console.log('\nLIST-DIR CHECKS PASSED (degraded: svn/svnadmin missing, synthetic .svn used)');
  process.exit(2);
}
console.log('\nALL LIST-DIR CHECKS PASSED');
