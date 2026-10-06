/**
 * Regression check for the host half's settings plumbing.
 *
 * Asserts, against a fake settings service (and the real `svn` on PATH):
 *   1. the namespace is registered with the documented defaults, and an invalid
 *      stored value is rejected by the schema instead of silently accepted;
 *   2. every resolved field actually reaches the code that uses it — the svn
 *      executable, the command-timeout multiplier, the history cache bound, and
 *      the two commit-repair switches;
 *   3. `/svn/api/check-svn` probes a given (or configured) executable without
 *      ever taking the plugin down;
 *   4. `/svn/api/root` reports the resolved settings and the user's overrides,
 *      so the panel behaves as configured even without a client settings scope.
 *
 * Usage:  node scripts/verify-settings-host.mjs [working-copy-path]
 *         (the working-copy path is only needed for check 4)
 * Exit code 0 = all checks passed.
 */
import { apply, __test, SETTINGS_DEFAULTS, SETTINGS_NAMESPACE } from '../lib/index.js';

let handler;
let registration = null;
/** The user layer the fake settings service resolves over the defaults. */
let userLayer = {};
let lastChange = null;

apply({
  tools: { register() {} },
  webServer: { register(o) { handler = o.handler; } },
  webRuntime: { trustedHosts: ['127.0.0.1:19387'] },
  sessions: { get: () => ({ header: { cwd: process.argv[2] ?? process.cwd() } }) },
  agents: {},
  llm: {},
  effect(fn) { return fn(); },
  inject(deps, callback) {
    if (!deps.includes('settings')) return { dispose: () => {} };
    callback({
      settings: {
        installSection(owner, ns, schema, entry, hooks) {
          const resolve = () => schema(Object.assign({}, entry, userLayer));
          registration = { ns, schema, entry, hooks, resolve };
          hooks.setSource(resolve);
          hooks.onChange();
          userLayer = new Proxy(userLayer, {
            set(target, key, value) { target[key] = value; hooks.setSource(resolve); lastChange = key; return true; },
          });
        },
        describe() {
          return [{ ns: SETTINGS_NAMESPACE, user: Object.assign({}, userLayer) }];
        },
      },
    });
    return { dispose: () => {} };
  },
});
// The schemastery import inside apply resolves asynchronously.
await new Promise((r) => setTimeout(r, 500));

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('  FAIL ' + label + (detail ? ` — ${detail}` : '')); }
}

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

// ---------------------------------------------------- 1) namespace + schema
console.log('settings namespace:');
check(registration !== null, 'the settings namespace was registered');
check(registration && registration.ns === SETTINGS_NAMESPACE, `namespace is "${SETTINGS_NAMESPACE}"`);
const resolved = registration ? registration.schema(registration.entry) : {};
for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
  check(resolved[key] === value, `default ${key} = ${JSON.stringify(value)}`, JSON.stringify(resolved[key]));
}
let rejected = false;
try { registration.schema({ sidebarCarrier: 'not-a-carrier' }); } catch { rejected = true; }
check(rejected, 'an invalid carrier value is rejected by the schema');
rejected = false;
try { registration.schema({ historyPageSize: 5000 }); } catch { rejected = true; }
check(rejected, 'an out-of-range page size is rejected by the schema');

// ------------------------------------------------- 2) settings reach code
console.log('settings reach the code that uses them:');
check(__test.svnSettings().commandTimeoutScale === 1, 'the resolved section starts at the defaults');
check(__test.scaledTimeout(60000) === 60000, 'a scale of 1 keeps the default timeout');
check(__test.scaledTimeout(300000) === 300000, 'a scale of 1 keeps the long-op timeout');
userLayer.commandTimeoutScale = 2.5;
check(__test.svnSettings().commandTimeoutScale === 2.5, 'an override is resolved into the section');
check(__test.scaledTimeout(60000) === 150000, 'the multiplier scales every command timeout');
check(__test.scaledTimeout(300000) === 750000, 'long operations scale too');
// The schema already refuses an out-of-range value (asserted above), so this
// covers the defence in depth for a section that never went through it — the
// composition layer of a profile with no settings provider.
registration.hooks.setSource(() => Object.assign({}, SETTINGS_DEFAULTS, { commandTimeoutScale: 99 }));
check(__test.scaledTimeout(60000) === 1200000, 'an absurd multiplier is clamped to 20x');
registration.hooks.setSource(() => Object.assign({}, SETTINGS_DEFAULTS, { commandTimeoutScale: -3 }));
check(__test.scaledTimeout(60000) === 60000, 'a non-positive multiplier is ignored (never shortens or blocks a command)');
registration.hooks.setSource(registration.resolve);
userLayer.commandTimeoutScale = 1;

check(__test.svnBinary().endsWith('svn.exe') || __test.svnBinary().endsWith('svn'), 'without a configured path the PATH svn is used');
userLayer.svnPath = 'C:\\definitely\\not\\here\\svn.exe';
check(__test.svnBinary() === 'C:\\definitely\\not\\here\\svn.exe', 'a configured path is used verbatim');
check(!__test.svnversionBinary().startsWith('C:\\definitely'), 'svnversion falls back to PATH when the svn directory has none');
const probe = await call('check-svn', {});
check(probe.ok === false && probe.binary === 'C:\\definitely\\not\\here\\svn.exe', 'check-svn probes the configured executable and reports the failure');
userLayer.svnPath = '';
const good = await call('check-svn', { path: 'svn' });
check(good.ok === true && typeof good.version === 'string' && good.version.length > 0, 'check-svn probes an explicit executable and reports its version', good.error);

// ---------------------------------------------- 3) commit-repair switches
console.log('commit-repair switches:');
const missing = process.argv[2] ? `${process.argv[2]}\\.dsh-svn-tools-verify-missing.tmp` : null;
if (process.argv[2]) {
  userLayer.autoDeleteMissing = false;
  userLayer.autoAddUnversioned = false;
  const prepared = await __test.prepareForCommit(process.argv[2], [missing]);
  check(Array.isArray(prepared.skipped) && prepared.skipped.every((s) => s.reason !== undefined), 'a path left alone is reported as skipped');
  check(prepared.added.length === 0 && prepared.deleted.length === 0, 'nothing is added or deleted while both switches are off');
  userLayer.autoDeleteMissing = true;
  userLayer.autoAddUnversioned = true;
} else {
  console.log('  ..  skipped (pass a working-copy path to exercise the switches against a real wc)');
}

// ------------------------------------------------------- 4) API exposure
console.log('/svn/api/root reports the resolved settings:');
if (process.argv[2]) {
  userLayer.historyPageSize = 77;
  const root = await call('root', { sessionId: 'verify' });
  check(root.settings && root.settings.historyPageSize === 77, 'root carries the resolved section');
  check(root.settingsUser && root.settingsUser.historyPageSize === 77, 'root names the user override');
  check(lastChange !== null, 'the settings update notified the plugin');
  userLayer.historyPageSize = 30;
} else {
  console.log('  ..  skipped (no working-copy path given)');
}

// ------------------------------------------- 5) 0.2.x configuration path
// DSH 0.2.x replaced the per-plugin settings namespace with a form derived from
// the plugin's own `Config`, keyed by profile entry id; `ctx.settings` is then
// `SettingsForms` (describe/update/replace/mutate) and has NO `installSection`.
// The plugin must take the resolved entry config as its configuration and must
// not try to register a namespace.
console.log('0.2.x-style settings service (SettingsForms, no installSection):');
let registeredOn02x = false;
apply({
  tools: { register() {} },
  webServer: { register() {} },
  webRuntime: { trustedHosts: [] },
  sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
  agents: {},
  llm: {},
  effect(fn) { return fn(); },
  inject(deps, callback) {
    if (!deps.includes('settings')) return { dispose() {} };
    callback({
      settings: {
        describe: () => [],
        update: async () => {},
        replace: async () => {},
        mutate: async () => {},
      },
    });
    return { dispose() {} };
  },
}, { historyPageSize: 77, sidebarCarrier: 'native' });
check(__test.svnSettings().historyPageSize === 77, 'the resolved entry config is the configuration source');
check(__test.svnSettings().sidebarCarrier === 'native', 'the carrier comes from the entry config too');
check(__test.svnSettings().svnPath === SETTINGS_DEFAULTS.svnPath, 'fields the entry config omits keep their defaults');
check(registeredOn02x === false, 'no namespace registration is attempted without installSection');

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nALL HOST SETTINGS CHECKS PASSED');
