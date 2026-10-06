/**
 * Regression check for the SVN panel's 在线 / 离线 / 只读 mode behaviour.
 *
 * The plugin has no build step and no test runner (the client half is a plain
 * CommonJS bundle), so this script loads lib/client.js in Node with a minimal
 * window stub and:
 *   1. asserts the pure mode policy (`blockMethod`) — which /svn/api methods
 *      are refused offline and in read-only mode;
 *   2. statically renders the sidebar panel in each mode and asserts the mode
 *      chip, the banner, the 「离线 / 重试」 choice and the deliberate ABSENCE
 *      of any 「设为默认值 / 永远离线」 affordance.
 *
 * Usage:  node scripts/verify-offline-modes.mjs [working-copy-path]
 * Exit code 0 = all checks passed.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// react lives in the dsh profile's node_modules (this package is installed as a
// link inside it); resolve from the profile root, then fall back to a plain
// resolve so the script also works from a standalone checkout.
let React;
let renderToStaticMarkup;
const candidates = [
  path.resolve(here, '../../../node_modules'),
  path.resolve(here, '..'),
];
let lastError;
for (const root of candidates) {
  try {
    const req = createRequire(path.join(root, 'noop.js'));
    React = req('react');
    renderToStaticMarkup = req('react-dom/server').renderToStaticMarkup;
    break;
  } catch (error) { lastError = error; }
}
if (!React || !renderToStaticMarkup) {
  console.error('cannot load react / react-dom (run this from the dsh profile that has the plugin installed)');
  console.error(String(lastError && lastError.message));
  process.exit(2);
}

let failures = 0;
function check(cond, label) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('  FAIL ' + label); }
}

// ------------------------------------------------------------- bundle load
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  alert() {},
  confirm: () => true,
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, remove() {}, appendChild() {} }),
  head: { appendChild() {} },
};

let bundled;
globalThis.window.__ModuleLoader__ = { load: (m) => { bundled = m; } };
const code = readFileSync(path.join(here, '../lib/client.js'), 'utf8');
new Function('require', 'module', 'exports', 'window', code)(
  (id) => (id === 'react' ? React : createRequire(path.join(candidates[0], 'noop.js'))(id)),
  { exports: {} },
  {},
  globalThis.window,
);
if (!bundled) {
  console.error('lib/client.js did not register with window.__ModuleLoader__');
  process.exit(2);
}

// The seam is created when the factory body runs, so materialize the module
// once before reading it (`apply` is not called yet).
const mod = bundled.factory((id) => (id === 'react' ? React : createRequire(path.join(candidates[0], 'noop.js'))(id)));

// ------------------------------------------------------ 1) mode policy
const t = globalThis.window.__dshSvnToolsTest;
if (!t) {
  console.error('lib/client.js does not expose its mode-policy test seam (window.__dshSvnToolsTest)');
  process.exit(2);
}
console.log('mode policy (blockMethod):');
check(t.blockMethod('online', 'commit') === undefined, 'online allows commit');
check(t.blockMethod('online', 'status') === undefined, 'online allows status');
check(/只读模式/.test(t.blockMethod('read-only', 'commit')), 'read-only blocks commit');
check(/只读模式/.test(t.blockMethod('read-only', 'add')), 'read-only blocks add');
check(/只读模式/.test(t.blockMethod('read-only', 'history-revert')), 'read-only blocks history revert');
check(t.blockMethod('read-only', 'status') === undefined, 'read-only allows status');
check(t.blockMethod('read-only', 'diff') === undefined, 'read-only allows diff');
check(t.blockMethod('read-only', 'log') === undefined, 'read-only allows the history list');
check(/离线模式/.test(t.blockMethod('offline', 'commit')), 'offline blocks commit');
check(/离线模式/.test(t.blockMethod('offline', 'update-start')), 'offline blocks update');
check(/离线模式/.test(t.blockMethod('offline', 'delete')), 'offline blocks delete');
check(t.blockMethod('offline', 'status') === undefined, 'offline allows status');
check(t.blockMethod('offline', 'diff') === undefined, 'offline allows diff (local BASE↔WC)');
check(t.blockMethod('offline', 'log') === undefined, 'offline allows the cached history');
check(t.blockMethod('offline', 'history-prev-revs') === undefined, 'offline allows prev-rev labels');
check(t.blockMethod('offline', 'locks') === undefined, 'offline allows local locks');
console.log('write classification stays in sync with the host:');
// `export` writes a copy of the tree to a caller-named directory and
// propset/propdel change versioned properties: all three must be treated as
// writes (the host's WRITE_API_METHODS carries the same three).
check(/只读模式/.test(t.blockMethod('read-only', 'export')), 'read-only blocks export');
check(/只读模式/.test(t.blockMethod('read-only', 'propset')), 'read-only blocks propset');
check(/只读模式/.test(t.blockMethod('read-only', 'propdel')), 'read-only blocks propdel');
check(/离线模式/.test(t.blockMethod('offline', 'export')), 'offline blocks export');
check(t.WRITE_METHODS.export === 1 && t.WRITE_METHODS.propset === 1 && t.WRITE_METHODS.propdel === 1,
  'WRITE_METHODS carries export/propset/propdel');
console.log('transport-error retry never replays a write:');
check(t.shouldRetryLocally('status') === true, 'reads may be replayed against local data');
check(t.shouldRetryLocally('log') === true, 'the cached history may be replayed');
check(t.shouldRetryLocally('diff') === true, 'the local BASE↔WC diff may be replayed');
for (const write of ['commit', 'update-start', 'update', 'export', 'propset', 'propdel', 'revert', 'history-revert']) {
  check(t.shouldRetryLocally(write) === false, `a failed ${write} is never replayed (no double execution)`);
}
console.log('"not a working copy" detection (checkout-form gate):');
check(t.isNotAWorkingCopy('svn: E155007: Not a working copy') === true, 'E155007 opens the checkout form');
check(t.isNotAWorkingCopy("svn status failed: svn: E155007: 'D:\\x' is not a working copy") === true, 'the English wording is recognised');
check(t.isNotAWorkingCopy('svn: E155007: 不是工作副本') === true, 'the localized wording is recognised');
// The three E155004/E155036 cases below used to be swallowed by a bare
// /working copy/ test, hiding the real error behind the checkout form.
check(t.isNotAWorkingCopy("svn: E155004: Working copy 'D:\\x' locked") === false, 'E155004 (locked) surfaces its real error');
check(t.isNotAWorkingCopy("svn: E155036: Working copy 'D:\\x' is an old format") === false, 'E155036 (old format) surfaces its real error');
check(t.isNotAWorkingCopy('svn: E170013: Unable to connect to a repository') === false, 'a transport error is not a checkout case');
console.log('transport-error classification:');
check(t.isTransportError('svn log failed: svn: E170013: Unable to connect to a repository at URL') === true, 'E170013 is a transport error');
check(t.isTransportError('svn: E210005: No repository found in') === true, 'E210005 falls back to local data too');
check(t.isTransportError('svn: E155007: not a working copy') === false, 'E155007 is not a transport error');
check(t.isTransportError('svn: E170001: Authentication failed') === false, 'E170001 is not a transport error');

// ------------------------------------------------------ 2) panel render
// Minimal stand-in for the cordis client context: `inject` activates a
// callback for the services this fake provides (and does nothing for the ones
// it does not), `slots` records registrations, and `effect` owns a disposer.
let tab = null;
const slotsRegistered = [];
const fakeCtx = {
  betterSidebar: { registerTab: (x) => { tab = x; return () => { tab = null; }; } },
  slots: {
    inject(name, callback) {
      const dispose = callback();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    register(options, component) {
      slotsRegistered.push({ options, component });
      return () => { const i = slotsRegistered.findIndex((r) => r.options === options); if (i >= 0) slotsRegistered.splice(i, 1); };
    },
  },
  effect(fn) { return fn(); },
  inject(deps, callback) {
    for (const dep of deps) if (this[dep] === undefined) return () => {};
    const dispose = callback(this);
    return { dispose: () => { if (typeof dispose === 'function') dispose(); } };
  },
};
mod.apply(fakeCtx);
// The carrier now waits for the host's resolved settings before mounting (so a
// configured `off` never flashes a tab), so let that first fetch settle. This
// fake ctx has no host to answer, hence the stub.
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: { message: 'HTTP 404' } }) });
await new Promise((resolve) => setTimeout(resolve, 0));
delete globalThis.fetch;
if (!tab) {
  console.error("the 'svn' sidebar tab was not registered");
  process.exit(2);
}

const cwd = process.argv[2] ?? process.cwd();
function render() {
  return renderToStaticMarkup(tab.component({ scope: { sessionId: 'verify', cwd }, visible: true, width: 400, height: 700 }));
}

console.log('panel render — online (default):');
let html = render();
check(html.includes('dsh-svn-mode online'), 'mode chip is 在线');
check(html.includes('>离线<'), 'header offers the 离线 switch');
check(html.includes('>只读<'), 'header offers the 只读 switch');
check(!html.includes('dsh-svn-banner'), 'no banner while online');
check(!/永远离线|设为默认值/.test(html), 'no permanent-offline affordance anywhere');

console.log('panel render — offline (stored):');
store.set('dsh-svn-tools.mode', 'offline');
html = render();
check(html.includes('dsh-svn-mode offline'), 'mode chip is 离线');
check(html.includes('dsh-svn-banner offline'), 'offline banner is shown');
check(html.includes('>重试<'), 'banner offers 重试');
check(!/永远离线|设为默认值/.test(html), 'offline banner offers no permanent-offline option');
check(/>更新</.test(html) && (html.match(/disabled/g) || []).length >= 3, 'server-dependent actions are disabled');

console.log('panel render — read-only (stored):');
store.set('dsh-svn-tools.mode', 'read-only');
html = render();
check(html.includes('dsh-svn-mode readonly'), 'mode chip is 只读');
check(html.includes('dsh-svn-banner readonly'), 'read-only banner is shown');
check(html.includes('退出只读'), 'read-only banner offers the way out');

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nALL OFFLINE-MODE CHECKS PASSED');
