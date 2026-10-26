/**
 * Regression check for the 「+ 目录」 built-in directory browser (issue #4,
 * phase 3: `api.listDir` + the panel's own picker instead of the OS dialog).
 *
 * The client half is a CJS bundle with no build step, and react / react-dom
 * are NOT dependencies of this package (they are shell-seeded), so this script
 * loads lib/client.js against a MINIMAL React stub and asserts the rendered
 * tree of the pure presentation component `DirBrowser`:
 *   1. 读取中… while the listing is in flight, the server message when it fails;
 *   2. directories only, with the 检出根 > 检出内 precedence, the weak 非检出
 *      hint for a plain directory, and the loose-file count in the head;
 *   3. 「上一级」 disabled at a file-system root (parent === null);
 *   4. the truncation note names the real limit/total instead of a hardcoded 500;
 *   5. 「选择此目录」 hands the browsed path back and 「关闭」 closes — neither
 *      runs watch add by itself (the panel's 「添加」 still owns that);
 *   6. the start-path rule (typed absolute path → selected working copy → cwd).
 *
 * Usage:  node scripts/verify-dir-browser.mjs
 * Exit code 0 = all checks passed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else {
    failures++;
    console.error('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}

// ------------------------------------------------------------ react stub
// Only the parts the factory body touches before a component runs: the bundle
// does `var useState = React.useState` at load time, and the pure component
// only calls createElement. Hooks are never driven here (no host, no effects).
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: Object.assign({}, props, { children }),
  }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: 'Fragment',
};

// ---------------------------------------------------------- bundle load
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
const stubRequire = (id) => {
  if (id === 'react') return React;
  throw new Error('unexpected shell-seeded module: ' + id);
};
new Function('require', 'module', 'exports', 'window', code)(
  stubRequire, { exports: {} }, {}, globalThis.window,
);
if (!bundled) {
  console.error('lib/client.js did not register with window.__ModuleLoader__');
  process.exit(2);
}
bundled.factory(stubRequire);

const seam = globalThis.window.__dshSvnToolsTest;
if (!seam || typeof seam.DirBrowser !== 'function') {
  console.error('lib/client.js does not expose DirBrowser on window.__dshSvnToolsTest');
  process.exit(2);
}
const DirBrowser = seam.DirBrowser;

// ------------------------------------------------------------- renderer
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Serialise the element tree DirBrowser returns. Function components are
 *  invoked, which is exactly what react-dom would do for a hookless one. */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (Array.isArray(node)) return node.map(render).join('');
  const { type, props } = node;
  if (typeof type === 'function') return render(type(props || {}));
  const attrs = [];
  Object.keys(props || {}).forEach((key) => {
    if (key === 'children') return;
    const value = props[key];
    if (key === 'className') attrs.push(' class="' + esc(value) + '"');
    else if (value === true) attrs.push(' ' + key);
    else if (value === false || value === null || value === undefined || typeof value === 'function') return;
    else attrs.push(' ' + key + '="' + esc(value) + '"');
  });
  return '<' + type + attrs.join('') + '>' + render(props && props.children) + '</' + type + '>';
}

/** Visible text of a subtree (tags dropped), for label assertions. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function') return textOf(node.type(node.props || {}));
  return textOf(node.props && node.props.children);
}

/** Every rendered button (and its onClick) in document order. */
function buttons(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => buttons(child, out));
    return out;
  }
  if (typeof node.type === 'function') {
    buttons(node.type(node.props || {}), out);
    return out;
  }
  if (node.type === 'button') out.push({ text: textOf(node), props: node.props || {} });
  buttons(node.props && node.props.children, out);
  return out;
}

const BASE = {
  path: 'D:\\Work\\HoloX',
  parent: 'D:\\Work',
  entries: [
    { name: 'XCC-Deluxe', path: 'D:\\Work\\HoloX\\XCC-Deluxe', isDir: true, isWc: true, hasSvn: true },
    { name: 'tools', path: 'D:\\Work\\HoloX\\tools', isDir: true, isWc: true, hasSvn: false },
    { name: 'scratch', path: 'D:\\Work\\HoloX\\scratch', isDir: true, isWc: false, hasSvn: false },
    { name: 'README.md', path: 'D:\\Work\\HoloX\\README.md', isDir: false, isWc: false, hasSvn: false },
  ],
  loading: false,
  error: null,
  truncated: false,
  busy: false,
  onUp() { this.calls = (this.calls || []).concat('up'); },
  onOpen(p) { this.opened = (this.opened || []).concat(p); },
  onPick(p) { this.picked = (this.picked || []).concat(p); },
  onClose() { this.closed = (this.closed || 0) + 1; },
};

function view(overrides) {
  return DirBrowser(Object.assign({}, BASE, overrides));
}

// ---------------------------------------------------------------- states
console.log('states:');
let html = render(view({ entries: null, loading: true }));
check(html.indexOf('读取中…') !== -1, 'a pending listing renders 读取中…');
check(html.indexOf('D:\\Work\\HoloX') !== -1, 'the browsed path is shown in the head');

html = render(view({ entries: null, error: '目录不存在：D:\\nope' }));
check(html.indexOf('目录不存在：D:\\nope') !== -1, 'a failed listing renders the server message');
check(html.indexOf('读取中…') === -1, 'the error state does not also claim 读取中…');

html = render(view({ entries: [] }));
check(html.indexOf('此目录下没有子目录') !== -1, 'an empty directory says so');
check(html.indexOf('另有') === -1, 'an empty directory reports no file count');

// ------------------------------------------------------- entries / badges
console.log('entries:');
const tree = view({});
html = render(tree);
check(html.indexOf('XCC-Deluxe') !== -1 && html.indexOf('tools') !== -1 && html.indexOf('scratch') !== -1,
  'subdirectories are listed');
check(html.indexOf('README.md') === -1, 'files are not listed as rows');
check(html.indexOf('另有 1 个文件') !== -1, 'the loose files are counted in the head');
check(html.indexOf('检出根') !== -1, 'a checkout root gets the 检出根 badge');
check(html.indexOf('检出内') !== -1, 'a directory inside a checkout gets the 检出内 badge');
check(html.indexOf('非检出') !== -1, 'a directory outside any checkout gets the weak 非检出 hint');

// Per-row badge precedence: a checkout root is also "inside a checkout", but
// only 检出根 is rendered for that row (two badges would just be noise).
const rows = html.split('<button').filter((chunk) => chunk.indexOf('dsh-svn-browse-item') !== -1);
const rootRow = rows.find((chunk) => chunk.indexOf('XCC-Deluxe') !== -1) || '';
const innerRow = rows.find((chunk) => chunk.indexOf('>tools<') !== -1) || '';
check(rootRow.indexOf('检出根') !== -1 && rootRow.indexOf('检出内') === -1,
  'a checkout root shows 检出根 only', rootRow.slice(0, 200));
check(innerRow.indexOf('检出内') !== -1 && innerRow.indexOf('检出根') === -1,
  'a nested project directory shows 检出内 only', innerRow.slice(0, 200));

// --------------------------------------------------------------- parent
console.log('navigation:');
html = render(view({}));
check(html.indexOf('上一级：D:\\Work') !== -1, '上一级 points at the reported parent');
check(html.indexOf('已经是文件系统根目录') === -1, 'a directory below the root enables 上一级');

html = render(view({ path: 'D:\\', parent: null }));
const up = buttons(view({ parent: null })).find((b) => b.text === '上一级') || { props: {} };
check(up.props.disabled === true, '「上一级」 is disabled at a file-system root');
check(html.indexOf('已经是文件系统根目录') !== -1, 'the disabled 上一级 explains why');

// ------------------------------------------------------------ truncation
console.log('truncation:');
html = render(view({ truncated: true, total: 520, limit: 500 }));
check(html.indexOf('仅显示前 500 项（共 520 项）') !== -1, 'the note names the limit and the real total', html.slice(0, 400));
html = render(view({ truncated: false, total: 4, limit: 500 }));
check(html.indexOf('仅显示前') === -1, 'an untruncated listing has no truncation note');
// Old bundles/hosts may answer without total/limit: fall back to the cap alone.
html = render(view({ truncated: true }));
check(html.indexOf('仅显示前 500 项') !== -1, 'a response without total/limit still renders the cap');

// ------------------------------------------------------------- callbacks
console.log('callbacks:');
const picked = [];
const closed = [];
const opened = [];
let upCalls = 0;
const wired = view({
  onPick: (p) => picked.push(p),
  onClose: () => closed.push(1),
  onOpen: (p) => opened.push(p),
  onUp: () => { upCalls += 1; },
});
const wiredButtons = buttons(wired);
const pickBtn = wiredButtons.find((b) => b.text === '选择此目录');
const closeBtn = wiredButtons.find((b) => b.text === '关闭');
const upBtn = wiredButtons.find((b) => b.text === '上一级');
check(typeof pickBtn === 'object', '「选择此目录」 is rendered');
if (pickBtn) pickBtn.props.onClick();
check(picked.length === 1 && picked[0] === 'D:\\Work\\HoloX',
  '「选择此目录」 hands back the browsed path', JSON.stringify(picked));
if (closeBtn) closeBtn.props.onClick();
check(closed.length === 1, '「关闭」 closes the browser');
if (upBtn) upBtn.props.onClick();
check(upCalls === 1, '「上一级」 asks the parent for the parent directory');
const openBtn = wiredButtons.find((b) => b.text.indexOf('XCC-Deluxe') !== -1);
if (openBtn) openBtn.props.onClick();
check(opened.length === 1 && opened[0] === 'D:\\Work\\HoloX\\XCC-Deluxe',
  'clicking a row opens that directory', JSON.stringify(opened));

// ------------------------------------------------------------ start path
console.log('start path:');
const { looksAbsolute, browseStartPath } = seam;
check(looksAbsolute('D:\\Work\\Proj') === true, 'a drive path counts as absolute');
check(looksAbsolute('D:/Work/Proj') === true, 'a forward-slash drive path counts as absolute');
check(looksAbsolute('\\\\server\\share') === true, 'a UNC path counts as absolute');
check(looksAbsolute('/tmp') === true, 'a POSIX root counts as absolute');
check(looksAbsolute('Work/Proj') === false, 'a relative path does not');
check(looksAbsolute('') === false, 'an empty value does not');
check(browseStartPath('D:\\typed', 'C:\\wc', 'C:\\cwd') === 'D:\\typed',
  'a typed absolute path wins');
check(browseStartPath('', 'C:\\wc', 'C:\\cwd') === 'C:\\wc',
  'otherwise the selected working copy is the start');
check(browseStartPath('', null, 'C:\\cwd') === 'C:\\cwd',
  'otherwise the session cwd is the start');

// ------------------------------------------------------------------ done
if (failures > 0) {
  console.error('\n' + failures + ' DIR-BROWSER CHECK(S) FAILED');
  process.exit(1);
}
console.log('\nALL DIR-BROWSER CHECKS PASSED');
