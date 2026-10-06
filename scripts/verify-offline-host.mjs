/**
 * Regression check for the host half's offline behaviour, run against a REAL
 * working copy whose repository is unreachable (or reachable):
 *
 *   1. `log` with `mode: 'local'` answers from the log cache + the wc.db
 *      revision snapshot (never throwing a transport error), and merges cached
 *      entries over reconstructed ones;
 *   2. `connection` classifies the failure (unreachable vs E210005
 *      "no repository found");
 *   3. read-only mode is enforced server-side for write methods;
 *   4. `diff-sides-rev` reads the version the working copy holds from the
 *      local pristine store instead of failing, and labels a revision it
 *      cannot serve locally as "本地不可用" rather than "不存在";
 *   5. `history-revert` never deletes a file it cannot prove was added in the
 *      target revision (offline add-detection is conservative by design), and
 *      fails with a readable message instead of a raw svn transport dump.
 *
 * Usage: node scripts/verify-offline-host.mjs <working-copy-path>
 * Exit code 0 = all checks passed.
 */
import { apply } from '../lib/index.js';

const cwd = process.argv[2];
if (!cwd) {
  console.error('usage: node scripts/verify-offline-host.mjs <working-copy-path>');
  process.exit(2);
}

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('  FAIL ' + label + (detail ? ` — ${detail}` : '')); }
}

let handler;
apply({
  tools: { register() {} },
  webServer: { register(o) { handler = o.handler; } },
  webRuntime: { trustedHosts: ['127.0.0.1:19387'] },
  sessions: { get: () => ({ header: { cwd } }) },
  agents: {},
  llm: {},
  effect(fn) { return fn(); },
});
if (!handler) { console.error('the /svn/api handler was not registered'); process.exit(2); }

async function call(method, payload) {
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
        const parsed = JSON.parse(b);
        if (this.status !== 200 || parsed.ok !== true) reject(new Error(parsed?.error?.message || b.slice(0, 200)));
        else resolve(parsed.value);
      },
    };
    handler(req, res).catch(reject);
  });
}
async function callFails(method, payload) {
  try { return { failed: false, value: await call(method, payload) }; }
  catch (e) { return { failed: true, message: e.message }; }
}

console.log('working copy:', cwd);

// ---------------------------------------------------------------- 1) log
console.log('local history (mode: local):');
const local = await call('log', { sessionId: 'verify', mode: 'local', limit: 5, verbose: true });
check(Array.isArray(local.entries), 'entries is an array');
check(local.offline === true, 'reports offline: true');
check(local.mode === 'local', "mode is 'local'");
check(typeof local.note === 'string' && local.note.length > 0, 'carries an explanatory note');
const revs = local.entries.map((e) => e.revision);
check(revs.every((r, i) => i === 0 || revs[i - 1] > r), 'revisions are strictly descending', revs.join(','));
check(local.entries.every((e) => Number.isInteger(e.revision) && e.revision > 0), 'every entry has a positive integer revision');
check(local.entries.every((e) => e.source === 'cache' || e.source === 'local'), "every entry is tagged 'cache' or 'local'");
check(local.entries.every((e) => e.source !== 'local' || e.messageKnown === false),
  'reconstructed entries are flagged as having no log message');
check(local.localRevision !== null, 'reports the local revision', String(local.localRevision));

const page = await call('log', { sessionId: 'verify', mode: 'local', limit: 2, verbose: true, olderThan: revs[1] });
check(page.entries.every((e) => e.revision < revs[1]), 'olderThan pages strictly below the bound',
  page.entries.map((e) => e.revision).join(','));

// --------------------------------------------------------- 2) connection
console.log('connection classification:');
const conn = await call('connection', { sessionId: 'verify', probe: true });
check(['online', 'offline'].includes(conn.mode), 'mode is online or offline', conn.mode);
check(conn.reachable === true || conn.reachable === false, 'reachable is boolean after a probe', String(conn.reachable));
if (conn.reachable === false) {
  check(['unreachable', 'repository-missing'].includes(conn.reason), 'offline carries a classified reason', String(conn.reason));
  check(typeof conn.error === 'string' && conn.error.length > 0, 'offline reports the underlying error');
}

// ---------------------------------------------------------- 3) read-only
console.log('read-only enforcement:');
const roWrite = await callFails('add', { sessionId: 'verify', readOnly: true, paths: ['definitely-missing-file.txt'] });
check(roWrite.failed && /只读模式/.test(roWrite.message), 'write methods are refused with readOnly', roWrite.message);
const roRead = await callFails('status', { sessionId: 'verify', readOnly: true });
check(!roRead.failed, 'read methods still work with readOnly', roRead.message);

// ------------------------------------------------- 4) offline history diff
console.log('offline history diff (pristine store):');
const fileEntry = local.entries.find((e) => e.paths && e.paths.some((p) => p.kind !== 'dir' && /\.(js|json|md|txt|vue)$/i.test(p.path)));
if (fileEntry) {
  const repoRel = fileEntry.paths.find((p) => p.kind !== 'dir' && /\.(js|json|md|txt|vue)$/i.test(p.path)).path;
  const diff = await call('diff-sides-rev', { sessionId: 'verify', repoRel, revision: fileEntry.revision });
  console.log(`  (probed ${repoRel} at r${fileEntry.revision})`);
  check(diff.binary !== undefined, 'diff answers structurally');
  if (!diff.binary) {
    const labels = `${diff.leftLabel} / ${diff.rightLabel}`;
    check(typeof diff.unavailable === 'boolean', 'reports whether a side was locally unavailable', labels);
    check(diff.unavailable !== true || /本地不可用/.test(labels),
      'an unavailable side is labelled 本地不可用 (never 不存在)', labels);
    check(diff.unavailable !== true || !/（不存在）/.test(labels),
      'an unavailable side is never claimed to not exist', labels);
  }

  // 5) offline revert must not delete anything it cannot prove
  const rev = await callFails('history-revert', { sessionId: 'verify', repoRel, revision: fileEntry.revision, mode: 'restore' });
  if (rev.failed) {
    check(/离线|无法/.test(rev.message) && !/E170013|E210005|No repository found/.test(rev.message),
      'offline revert fails with a readable message, not a raw transport dump', rev.message);
  } else {
    check(['revert', 'content', 'unchanged', 'restore-add'].includes(rev.value.effect),
      'offline revert only takes a content-preserving path', String(rev.value.effect));
    check(rev.value.effect !== 'delete', 'offline revert never deletes through the added-in-rN guess');
  }
} else {
  console.log('  (no local file entry available to probe — skipped)');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nALL HOST OFFLINE CHECKS PASSED');
