/**
 * Regression check for the settings surface and the sidebar-carrier switch.
 *
 * What it pins down (all of it without a build step, a browser, or a server):
 *   1. `resolveCarrier` — which carrier a configured mode actually uses, and
 *      when an unavailable choice falls back to the other carrier instead of
 *      leaving the user without a panel;
 *   2. the shared settings store — defaults, the host fallback layer folded in
 *      from `/svn/api/root`, override detection, writes through the scope, and
 *      the "settings transport unavailable" state;
 *   3. `apply` — that the DSH built-in right Sidebar gets the tab type + body
 *      under the plugin's namespace id, that switching the setting disposes the
 *      old carrier and registers the new one, and that `off` disposes both;
 *   4. the settings card renders its rows, marks overridden fields, and goes
 *      read-only when the document is unavailable;
 *   5. the panel-side setting reads (`pageSizeOf` / `defaultViewOf` /
 *      `showUnversionedOf`) clamp what a hand-edited settings.yaml may contain.
 *
 * Usage:  node scripts/verify-settings.mjs
 * Exit code 0 = all checks passed.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
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
const requireFrom = (id) => (id === 'react' ? React : createRequire(path.join(candidates[0], 'noop.js'))(id));
const mod = bundled.factory(requireFrom);
const seam = globalThis.window.__dshSvnToolsTest;
if (!seam) {
  console.error('lib/client.js does not expose its test seam (window.__dshSvnToolsTest)');
  process.exit(2);
}
const h = (type, props) => React.createElement(type, props);

// ------------------------------------------------------- 1) carrier policy
console.log('carrier resolution:');
const both = { native: true, better: true };
const onlyBetter = { native: false, better: true };
const onlyNative = { native: true, better: false };
const neither = { native: false, better: false };
check(seam.resolveCarrier('auto', both).kind === 'native', 'auto prefers the built-in sidebar');
check(seam.resolveCarrier('auto', onlyBetter).kind === 'better-sidebar', 'auto falls to better-sidebar without the built-in one');
check(seam.resolveCarrier('auto', neither).kind === 'off', 'auto registers nothing when no carrier exists');
check(seam.resolveCarrier('native', onlyNative).kind === 'native', 'native is honoured when available');
check(seam.resolveCarrier('native', onlyBetter).kind === 'better-sidebar' && seam.resolveCarrier('native', onlyBetter).fallback === true,
  'native degrades to better-sidebar (and reports it) when unavailable');
check(seam.resolveCarrier('better-sidebar', onlyNative).kind === 'native' && seam.resolveCarrier('better-sidebar', onlyNative).fallback === true,
  'better-sidebar degrades to the built-in one (and reports it) when unavailable');
check(seam.resolveCarrier('better-sidebar', neither).fallback === true, 'an unusable explicit choice reports the fallback');
check(seam.resolveCarrier('off', both).kind === 'off', 'off really means off');
check(seam.resolveCarrier('nonsense', both).kind === 'native', 'an unknown mode behaves as auto');

// ------------------------------------------------------- 2) settings store
console.log('settings store:');
function makeFakeScope(initial) {
  const state = {
    status: 'ready',
    value: Object.assign({}, seam.SETTINGS_DEFAULTS, initial || {}),
    user: {},
    base: {},
    revision: 1,
    writable: true,
    mode: 'host',
  };
  const listeners = [];
  const scope = {
    getSnapshot: () => state,
    subscribe: (fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    set: (key, value) => {
      state.user = Object.assign({}, state.user, { [key]: value });
      state.value = Object.assign({}, state.value, { [key]: value });
      state.revision += 1;
      listeners.slice().forEach((fn) => fn());
      return Promise.resolve();
    },
    unset: (key) => {
      const user = Object.assign({}, state.user);
      delete user[key];
      state.user = user;
      state.value = Object.assign({}, state.value, { [key]: seam.SETTINGS_DEFAULTS[key] });
      state.revision += 1;
      listeners.slice().forEach((fn) => fn());
      return Promise.resolve();
    },
  };
  return { state, scope, binder: { bind: () => scope } };
}

const plain = seam.createSettingsStore();
check(plain.get('sidebarCarrier') === 'auto', 'an unbound store answers the documented defaults');
check(plain.get('historyPageSize') === 30, 'default history page size is 30');
check(plain.snapshot().status === 'defaults', 'an unbound store reports the defaults state');
check(plain.overridden('sidebarCarrier') === false, 'nothing is overridden before the settings answer');

const fake = makeFakeScope({ sidebarCarrier: 'native', historyPageSize: 50 });
// What the user overrode, as `settings.describe()` reports it: the presence of
// the key — not its value — is what marks a field overridden.
fake.state.user = { sidebarCarrier: 'native' };
const bound = seam.createSettingsStore();
bound.bindScope(fake.binder);
check(bound.get('sidebarCarrier') === 'native', 'a bound store answers the document value');
check(bound.get('historyPageSize') === 50, 'the document value wins over the default');
check(bound.get('commandTimeoutScale') === 1, 'fields the document omits keep their default');
check(bound.snapshot().status === 'ready', 'a bound store reports ready');
check(bound.snapshot().writable === true, 'a host-mode document is writable');
check(bound.overridden('sidebarCarrier') === true, 'presence in the user layer marks a field overridden');
check(bound.overridden('svnPath') === false, 'an untouched field is not overridden');

let notified = 0;
const off = bound.subscribe(() => { notified += 1; });
await bound.set('defaultView', 'history');
check(bound.get('defaultView') === 'history', 'set writes through the scope');
check(notified > 0, 'a write notifies subscribers');
await bound.unset('defaultView');
check(bound.get('defaultView') === 'commit', 'unset returns the field to its default');
bound.subscribe(() => {});
off();

const hostOnly = seam.createSettingsStore();
hostOnly.hydrate({ historyPageSize: 12 }, { historyPageSize: 12 });
check(hostOnly.get('historyPageSize') === 12, 'the host fallback layer is folded in');
check(hostOnly.snapshot().status === 'host', 'the host-only state is named');
check(hostOnly.snapshot().writable === false, 'the host fallback alone is not writable');
check(hostOnly.overridden('historyPageSize') === true, 'the host fallback also reports overrides');

const unavailable = seam.createSettingsStore();
const unavailableScope = makeFakeScope({});
unavailableScope.state.status = 'unavailable';
unavailableScope.state.writable = false;
unavailable.bindScope(unavailableScope.binder);
check(unavailable.snapshot().status === 'unavailable', 'an unavailable document is reported');
check(unavailable.snapshot().writable === false, 'an unavailable document is not writable');

let writeRejected = false;
const unbound = seam.createSettingsStore();
await unbound.set('svnPath', 'x').catch(() => { writeRejected = true; });
check(writeRejected, 'a write without a settings scope is refused (never silently dropped)');

// ------------------------------------------------------- 3) carrier switch
console.log('carrier registration:');
function makeHost() {
  const record = {
    types: [],
    bodies: [],
    cards: [],
    betterTabs: [],
    disposed: [],
  };
  const makeDisposer = (label) => { let done = false; return () => { if (done) return; done = true; record.disposed.push(label); }; };
  const host = {
    sidebarRight: { openTab() {} },
    sidebarRightTabs: {
      register(definition) { record.types.push(definition); return makeDisposer('type:' + definition.kind); },
    },
    betterSidebar: {
      registerTab(tab) { record.betterTabs.push(tab); return makeDisposer('better:' + tab.id); },
    },
    slots: {
      inject(name, callback) {
        const dispose = callback();
        return () => { if (typeof dispose === 'function') dispose(); };
      },
      register(options) {
        if (options.name === 'sidebar.right.pane.tab') record.bodies.push(options);
        else record.cards.push(options);
        return makeDisposer(options.name + ':' + (options.key || options.id));
      },
    },
    effect(fn) { const dispose = fn(); return dispose; },
    inject(deps, callback) {
      for (const dep of deps) if (this[dep] === undefined) return () => {};
      const dispose = callback(this);
      return { dispose: () => { if (typeof dispose === 'function') dispose(); } };
    },
  };
  return { host, record };
}

const switchScope = makeFakeScope({});
const { host, record } = makeHost();
host.settingsScope = switchScope.binder;
mod.apply(host);
check(record.types.length === 1 && record.types[0].kind === 'svn', 'the built-in sidebar gets the svn tab type');
check(record.types[0].id === 'dsh-svn-tools', 'the tab type is identified by the package id');
check(typeof record.types[0].title() === 'string' && record.types[0].title().includes('SVN'), 'the tab chip is named SVN');
check(Array.isArray(record.types[0].guide) && record.types[0].guide.length === 1, 'the type offers one guide entry');
check(record.bodies.length === 1 && record.bodies[0].key === 'dsh-svn-tools', 'the panel body registers under the type id');
check(record.cards.length === 1 && record.cards[0].name === 'settings.plugin.item', 'the settings card registers in the plugins section');
check(record.cards[0].key === seam.SETTINGS_NS, 'the card is keyed by the settings namespace');
check(record.betterTabs.length === 0, 'the better-sidebar carrier stays unused while the built-in one is available');

// Switch to the better-sidebar carrier: the native registration must go away.
await switchScope.scope.set('sidebarCarrier', 'better-sidebar');
check(record.disposed.includes('type:svn'), 'switching disposes the built-in tab type');
check(record.disposed.includes('sidebar.right.pane.tab:dsh-svn-tools'), 'switching disposes the built-in tab body');
check(record.betterTabs.length === 1 && record.betterTabs[0].id === 'svn', 'switching registers the better-sidebar tab');

// And off: the panel disappears entirely, the agent tools are untouched.
await switchScope.scope.set('sidebarCarrier', 'off');
check(record.disposed.includes('better:svn'), 'off disposes the better-sidebar tab');

// ------------------------------------------------------- 4) settings card
console.log('settings card render:');
const cardScope = makeFakeScope({ svnPath: 'D:\\Tools\\svn\\svn.exe' });
cardScope.state.user = { svnPath: 'D:\\Tools\\svn\\svn.exe' };
const cardStore = seam.createSettingsStore();
cardStore.bindScope(cardScope.binder);
let cardHtml = renderToStaticMarkup(h(seam.SvnSettingsCard, { svnSettings: cardStore, svnCarrier: null }));
check(cardHtml.includes('侧边栏载体'), 'the carrier row is rendered');
check(cardHtml.includes('dsH 自带侧边栏') || cardHtml.includes('DSH 自带侧边栏'), 'the built-in sidebar is offered by name');
check(cardHtml.includes('dsh-better-sidebar 插件'), 'the better-sidebar carrier is offered by name');
check(cardHtml.includes('svn 可执行文件'), 'the svn path row is rendered');
check(cardHtml.includes('命令超时倍数'), 'the timeout row is rendered');
check(cardHtml.includes('历史每页条数'), 'the history page-size row is rendered');
check(cardHtml.includes('本地历史缓存'), 'the history cache row is rendered');
check(cardHtml.includes('提交：自动添加') && cardHtml.includes('提交：自动删除'), 'both commit-repair rows are rendered');
check(cardHtml.includes('面板默认分页'), 'the default-view row is rendered');
check(cardHtml.includes('已改'), 'an overridden field is marked');
check(cardHtml.includes('恢复默认'), 'an override offers its reset');
check(cardHtml.includes('settings.yaml'), 'the card says where the change lands');
check(!cardHtml.includes('设置存储在本页不可用'), 'an available document shows no unavailable notice');

const unavailableCard = seam.createSettingsStore();
const unavailableCardScope = makeFakeScope({});
unavailableCardScope.state.status = 'unavailable';
unavailableCardScope.state.writable = false;
unavailableCard.bindScope(unavailableCardScope.binder);
cardHtml = renderToStaticMarkup(h(seam.SvnSettingsCard, { svnSettings: unavailableCard, svnCarrier: null }));
check(cardHtml.includes('设置存储在本页不可用'), 'an unavailable document explains itself');
check(cardHtml.includes('disabled'), 'its controls are disabled');

// --------------------------------------------------- 5) panel-side clamps
console.log('panel-side setting reads:');
check(seam.pageSizeOf({ historyPageSize: 30 }) === 30, 'page size passes through');
check(seam.pageSizeOf({ historyPageSize: 5 }) === 5, 'the lower bound is accepted');
check(seam.pageSizeOf({ historyPageSize: 500 }) === 30, 'an out-of-range page size falls back to the default');
check(seam.pageSizeOf({ historyPageSize: 'abc' }) === 30, 'a non-numeric page size falls back to the default');
check(seam.pageSizeOf({}) === 30, 'an absent page size falls back to the default');
check(seam.defaultViewOf({ defaultView: 'history' }) === 'history', 'the default page is honoured');
check(seam.defaultViewOf({ defaultView: 'nope' }) === 'commit', 'an unknown page falls back to 提交');
check(seam.showUnversionedOf({ showUnversionedDefault: false }) === false, 'hiding unversioned files by default is honoured');
check(seam.showUnversionedOf({}) === true, 'the default lists unversioned files');

// The panel itself renders the configured default page and hides unversioned
// files on 提交 when told to.
const panelStore = seam.createSettingsStore();
const panelScope = makeFakeScope({ defaultView: 'locks', showUnversionedDefault: false });
panelStore.bindScope(panelScope.binder);
const panelHtml = renderToStaticMarkup(h(seam.SvnPanel, {
  scope: { sessionId: 'verify', cwd: process.cwd() },
  visible: true,
  settings: panelStore,
}));
check(/dsh-svn-tabbtn on[^>]*>占用</.test(panelHtml), 'the panel opens on the configured 占用 page');
check(panelHtml.includes('没有文件被占用'), 'the configured page is the one rendered');

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nALL SETTINGS / CARRIER CHECKS PASSED');
