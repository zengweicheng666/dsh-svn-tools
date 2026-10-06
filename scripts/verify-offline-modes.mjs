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
