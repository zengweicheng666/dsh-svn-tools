/**
 * dsh-svn-tools — SVN (Subversion) tools + sidebar UI API for DeepSeek Harness.
 *
 * Registers svn_status / svn_info / svn_diff / svn_log / svn_add / svn_revert /
 * svn_update / svn_commit as agent tools, and a fenced JSON API under
 * /svn/api/* consumed by the client-side SVN sidebar panel (registered into
 * dsh-better-sidebar as the 'svn' tab).
 *
 * Commits follow the project rule of Chinese UTF-8 log messages: the message
 * is written to a UTF-8 temp file and submitted via
 * `svn commit --encoding utf-8 --non-interactive -F <file>`.
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fs, createReadStream, createWriteStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-svn-tools';
export const inject = ['tools', 'webServer', 'sessions', 'webRuntime', 'agents', 'llm'];

const SVN = process.platform === 'win32' ? 'svn.exe' : 'svn';
// TortoiseSVN ships svnversion.exe (a compact working-copy revision tool);
// on POSIX it's usually `svnversion`. It reports the working copy's *actual*
// revision including mixed-revision ranges (e.g. "752:754MP"), which
// `svn info` (base revision only) cannot.
const SVNVERSION = process.platform === 'win32' ? 'svnversion.exe' : 'svnversion';
const MAX_BODY = 1024 * 1024;

// --------------------------------------------------------------- settings
/**
 * The plugin's namespace in the DSH user-settings document
 * (`$DSH_HOME/settings.yaml`). The Host half registers it (see `apply`), which
 * is what makes the browser half's card appear in
 * Settings → Plugins → Plugin configuration; the browser half binds the same
 * namespace through `ctx.settingsScope` and writes the user layer.
 *
 * Every namespace field is a TOP-LEVEL scalar: the client scope's `set`/`unset`
 * address one path segment, so nested sections are deliberately avoided.
 */
export const SETTINGS_NAMESPACE = 'dsh-svn-tools';

/**
 * Values a reader may use before (or without) the settings service: the
 * documented defaults, mirrored by the client. Keep both in sync.
 */
export const SETTINGS_DEFAULTS = Object.freeze({
  /** Which sidebar hosts the SVN panel: auto | native | better-sidebar | off. */
  sidebarCarrier: 'auto',
  /** Absolute path of the `svn` executable; '' = the one on PATH. */
  svnPath: '',
  /** Multiplier applied to every command timeout (slow repos / big checkouts). */
  commandTimeoutScale: 1,
  /** Entries fetched per history page. */
  historyPageSize: 30,
  /** Keep the local `svn log` cache that makes the history page work offline. */
  historyCacheEnabled: true,
  /** Upper bound on cached revisions per working copy. */
  historyCacheMaxEntries: 20000,
  /** `svn add` unversioned files while preparing an explicit commit. */
  autoAddUnversioned: true,
  /** `svn delete --keep-local`-style cleanup for versioned-but-missing files. */
  autoDeleteMissing: true,
  /** Initial state of the 提交 page's 「显示无版本控制的文件」 switch. */
  showUnversionedDefault: true,
  /** Page the panel opens on: commit | history | locks. */
  defaultView: 'commit',
});

/** The live composition value of the namespace; replaced once the settings
 * service resolves (`installSection`'s `setSource`). */
let settingsSource = () => SETTINGS_DEFAULTS;
/** The settings service face, kept so the API can also report the raw user
 * layer (which fields the user overrode, as opposed to schema defaults). */
let settingsService = null;

/** The resolved settings section, layered over the documented defaults. */
function svnSettings() {
  try {
    const resolved = settingsSource?.();
    return resolved && typeof resolved === 'object' ? { ...SETTINGS_DEFAULTS, ...resolved } : SETTINGS_DEFAULTS;
  } catch {
    return SETTINGS_DEFAULTS;
  }
}

/**
 * The fields the user actually overrode, as `describe()` reports them. Used by
 * the browser card to mark a field as modified, and to keep working when the
 * client-side settings scope is unavailable.
 */
function svnSettingsUserLayer() {
  try {
    const descriptors = settingsService?.describe?.() ?? [];
    const mine = descriptors.find((d) => d.ns === SETTINGS_NAMESPACE);
    const user = mine?.user;
    return user && typeof user === 'object' ? user : {};
  } catch {
    return {};
  }
}

/** The `svn` executable to run: the configured path, else the one on PATH. */
function svnBinary() {
  const configured = svnSettings().svnPath;
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : SVN;
}

/** `svnversion` next to the configured `svn`, else the one on PATH. */
function svnversionBinary() {
  const svn = svnBinary();
  if (svn !== SVN) {
    const dir = path.dirname(svn);
    for (const name of process.platform === 'win32' ? ['svnversion.exe', 'svnversion'] : ['svnversion']) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return SVNVERSION;
}

/** Apply the user's 命令超时倍数 to one command's timeout. */
function scaledTimeout(ms) {
  const scale = Number(svnSettings().commandTimeoutScale);
  const safe = Number.isFinite(scale) && scale > 0 ? Math.min(Math.max(scale, 0.2), 20) : 1;
  return Math.max(1000, Math.round((ms ?? 60000) * safe));
}

/**
 * Test seam, mirroring the client half's `window.__dshSvnToolsTest`: the
 * settings resolution and the executable/timeout derivation are pure enough to
 * assert directly, and `scripts/verify-settings-host.mjs` does exactly that
 * (the namespace itself is only reachable through a live settings service).
 */
export const __test = { svnSettings, scaledTimeout, svnBinary, svnversionBinary, prepareForCommit };

// ---------------------------------------------------------- trust fence
// Same-origin request fence (mirrors the sidebar's trust-fence): the Host
// must be ours (loopback or a configured trusted host) and any browser
// markers must be same-origin.

function header(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(request.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).hostname === hostUrl.hostname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- svn core

/** Decode a command output buffer: UTF-8 strictly, fall back to GBK (Windows consoles). */
function decodeBuffer(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

/** Run one svn executable with an argument array (no shell), returning decoded stdout. */
function runSvnWith(binary, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      cwd: opts.cwd,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout: scaledTimeout(opts.timeout ?? 60000),
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      const out = decodeBuffer(stdout).trim();
      if (error) {
        const errText = decodeBuffer(stderr).trim() || out || error.message;
        reject(new Error(`svn ${args[0] ?? ''} failed: ${errText}`));
        return;
      }
      resolve(out);
    });
  });
}

/** Run the configured `svn` (Settings → SVN 可执行文件路径, else PATH). */
function runSvn(args, opts = {}) {
  return runSvnWith(svnBinary(), args, opts);
}

/** Resolve a raw path against a base directory; absolute paths pass through. */
function resolveTargetAbs(raw, base) {
  if (!raw) return base;
  if (path.isAbsolute(raw)) return raw;
  return base ? path.resolve(base, raw) : raw;
}

/** Run `svnversion` (TortoiseSVN) for a compact working-copy revision id. */
function runSvnversion(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(svnversionBinary(), args, {
      cwd: opts.cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: scaledTimeout(opts.timeout ?? 30000),
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      const out = decodeBuffer(stdout).trim();
      if (error) {
        const errText = decodeBuffer(stderr).trim() || out || error.message;
        reject(new Error(`svnversion failed: ${errText}`));
        return;
      }
      resolve(out);
    });
  });
}

/** Parse a `svnversion` identifier into structured local-revision info.
 * Handles "4168", "4123:4168", "4168M", "4123:4168MP", "Unversioned ...",
 * and returns { max, min, mixed, modified, switched, partial, externals,
 * raw }. When it cannot be parsed, returns null. */
function parseSvnversion(out) {
  const s = String(out ?? '').trim();
  if (s === '' || /^Unversioned|^Uncommitted|not a working copy/i.test(s)) return null;
  const m = s.match(/^(\d+)(?::(\d+))?([MSPX]*)$/);
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] !== undefined ? Number(m[2]) : min;
  const flags = m[3] ?? '';
  return {
    max,
    min,
    mixed: flags.includes('M') ? undefined : (m[2] !== undefined || undefined),
    hasMods: flags.includes('M') ? true : undefined,
    switched: flags.includes('S') ? true : undefined,
    partial: flags.includes('P') ? true : undefined,
    externals: flags.includes('X') ? true : undefined,
    raw: s,
  };
}

/** Resolve the working copy's actual local revision — prefer `svnversion`
 * (which reports mixed-revision ranges), falling back to `svn info`'s base
 * revision when svnversion is unavailable (e.g. no TortoiseSVN). Returns an
 * object { localRevision, localMin, mixed, hasMods, ... } or { localRevision:
 * null } when the path is not a working copy. */
async function localRevisionOf(cwd) {
  try {
    const out = await runSvnversion([cwd], { cwd, timeout: 30000 });
    const parsed = parseSvnversion(out);
    if (parsed !== null) {
      return {
        localRevision: parsed.max,
        localMin: parsed.min,
        mixed: parsed.min !== parsed.max,
        hasMods: parsed.hasMods,
        switched: parsed.switched,
        partial: parsed.partial,
        raw: parsed.raw,
      };
    }
  } catch { /* svnversion unavailable — fall through to svn info */ }
  try {
    const xml = await runSvn(['info', '--xml', '--', cwd], { cwd, timeout: 30000 });
    const rev = Number(tagAttr(xml, 'entry', 'revision') ?? 0);
    return { localRevision: rev > 0 ? rev : null, localMin: rev > 0 ? rev : null, mixed: false };
  } catch {
    return { localRevision: null, localMin: null, mixed: false };
  }
}

/** Resolve the session's authoritative working directory. */
function sessionCwdOf(ctx, sessionId, clientCwd) {
  try {
    const headerCwd = ctx.sessions?.get(sessionId)?.header?.cwd;
    if (headerCwd && headerCwd !== '') return headerCwd;
  } catch { /* session store unavailable */ }
  if (clientCwd && clientCwd !== '' && path.isAbsolute(clientCwd)) return clientCwd;
  return process.cwd();
}

// ------------------------------------------------------------- xml helpers

/** Unescape basic XML entities. */
function unescapeXml(s) {
  return s
    .replace(/&#13;/g, '\r')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Extract the first match of a non-nested tag's text content. */
function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? unescapeXml(m[1].trim()) : undefined;
}

/** Extract the first match of a tag's attribute value. */
function tagAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`));
  return m ? m[1] : undefined;
}

/** `svn status --xml` uses full words; map them to the conventional single-letter codes. */
const STATUS_CODE = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  replaced: 'R',
  conflicted: 'C',
  missing: '!',
  unversioned: '?',
  obstructed: '~',
  external: 'X',
  ignored: 'I',
  incomplete: '!',
  none: ' ',
  normal: ' ',
};

/** Parse `svn status --xml` into structured entries. Entries inside
 * `<changelist name="...">` blocks carry their changelist name. */
function parseStatus(xml) {
  // path -> changelist name (entries grouped under <changelist> blocks)
  const clByPath = new Map();
  const clRe = /<changelist\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/changelist>/g;
  let cl;
  while ((cl = clRe.exec(xml)) !== null) {
    const pre = /<entry\s+path="([^"]*)"[^>]*>/g;
    let p;
    while ((p = pre.exec(cl[2])) !== null) clByPath.set(p[1], cl[1]);
  }
  const entries = [];
  const re = /<entry\s+path="([^"]*)"[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[2];
    const item = tagAttr(body, 'wc-status', 'item');
    const props = tagAttr(body, 'wc-status', 'props');
    const revision = tagAttr(body, 'wc-status', 'revision');
    const commitRev = tagAttr(body, 'commit', 'revision');
    const author = tagText(body, 'author');
    const treeConflicted = /<tree-conflicted[^>]*>/.test(body);
    if (item !== undefined && item !== 'none' && item !== 'normal') {
      entries.push({
        path: m[1],
        status: STATUS_CODE[item] ?? item,
        props: props ?? 'none',
        revision: revision ?? undefined,
        lastChangedRevision: commitRev ?? undefined,
        lastChangedAuthor: author ?? undefined,
        treeConflict: treeConflicted || undefined,
        changelist: clByPath.get(m[1]) || undefined,
      });
    }
  }
  return entries;
}

/** Parse `svn status --xml -u` entries that carry a `<lock>` element
 * (files locked/occupied by someone — locked by the current user too, as
 * `svn status -u` reports remote lock state). */
function parseLocks(xml) {
  const entries = [];
  const re = /<entry\s+path="([^"]*)"[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[2];
    if (!/<lock\b[^>]*/.test(body)) continue;
    // svn prints lock data as child elements: <token>, <owner>, <created>…
    entries.push({
      path: m[1],
      owner: tagText(body, 'owner') ?? undefined,
      comment: tagText(body, 'comment') ?? undefined,
      created: tagText(body, 'created') ?? undefined,
      expiry: tagText(body, 'expires') ?? undefined,
      token: tagText(body, 'token') ?? undefined,
      item: tagAttr(body, 'wc-status', 'item'),
    });
  }
  return entries;
}

/** Parse `svn log --xml` into structured entries. */
function parseLog(xml) {
  const entries = [];
  const re = /<logentry\s+revision="([^"]*)"[^>]*>([\s\S]*?)<\/logentry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[2];
    const paths = [];
    const pre = /<path\s+([^>]*)>([\s\S]*?)<\/path>/g;
    let p;
    while ((p = pre.exec(body)) !== null) {
      paths.push({
        action: tagAttr(`<path ${p[1]}>`, 'path', 'action'),
        kind: tagAttr(`<path ${p[1]}>`, 'path', 'kind'),
        path: unescapeXml(p[2].trim()),
      });
    }
    entries.push({
      revision: Number(m[1]),
      author: tagText(body, 'author'),
      date: tagText(body, 'date'),
      message: tagText(body, 'msg'),
      paths: paths.length > 0 ? paths : undefined,
    });
  }
  return entries;
}

/** Parse `svn info --xml` into a flat object. */
function parseInfo(xml, target) {
  const entry = xml.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/);
  const body = entry ? entry[1] : xml;
  return {
    path: target,
    url: tagText(body, 'url'),
    relativeUrl: tagText(body, 'relative-url'),
    repositoryRoot: tagText(body, 'root'),
    repositoryUuid: tagText(body, 'repository/uuid'),
    revision: tagAttr(xml, 'entry', 'revision'),
    lastChangedRevision: tagAttr(body, 'commit', 'revision'),
    lastChangedAuthor: tagText(body, 'author'),
    lastChangedDate: tagText(body, 'date'),
    workingCopyRoot: tagText(body, 'wcroot-abspath'),
    schedule: tagText(body, 'schedule'),
    depth: tagText(body, 'depth'),
  };
}

// --------------------------------------------------------------- api layer

/** Read a JSON request body (bounded). */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data.trim() === '' ? {} : JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}

function writeError(res, error) {
  const status = typeof error?.status === 'number' ? error.status : 500;
  writeJson(res, status, {
    ok: false,
    error: {
      code: error?.code ?? 'error',
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

// ------------------------------------------------- svn subcommands
// Shared command runners: each takes the working-copy root as `cwd` and the
// raw argument object, and returns a JSON value. Agent tools and the web API
// both delegate here so the two surfaces never drift.

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'bad-request', status: 400 });
}

function pathsOf(args, cwd) {
  return (args.paths ?? []).map((x) => resolveTargetAbs(x, cwd)).filter(Boolean);
}

function requirePaths(args, cwd) {
  const targets = pathsOf(args, cwd);
  if (targets.length === 0) throw badRequest('paths are required');
  return targets;
}

/** Write a message to a UTF-8 temp file, run fn(file), always remove the file. */
async function withMsgFile(message, fn) {
  const f = path.join(os.tmpdir(), `dsh-svn-msg-${randomUUID()}.txt`);
  try {
    await fs.writeFile(f, message, { encoding: 'utf8' });
    return await fn(f);
  } finally {
    await fs.rm(f, { force: true }).catch(() => {});
  }
}

async function svnCleanup(cwd, args) {
  const targets = pathsOf(args, cwd);
  const argv = ['cleanup', '--non-interactive'];
  if (targets.length > 0) argv.push('--', ...targets);
  const output = await runSvn(argv, { cwd, timeout: 300000 });
  return { output };
}

async function svnResolve(cwd, args) {
  const targets = requirePaths(args, cwd);
  const accept = args.accept ?? 'working';
  const ACCEPTS = ['working', 'base', 'mine-conflict', 'theirs-conflict', 'mine-full', 'theirs-full', 'edit', 'launch'];
  if (!ACCEPTS.includes(accept)) throw badRequest(`accept must be one of ${ACCEPTS.join(', ')}`);
  const argv = ['resolve', '--non-interactive', '--accept', accept];
  if (args.recursive) argv.push('-R');
  argv.push('--', ...targets);
  const output = await runSvn(argv, { cwd, timeout: 60000 });
  return { output };
}

async function svnDelete(cwd, args) {
  const targets = requirePaths(args, cwd);
  const argv = ['delete', '--non-interactive'];
  if (args.keepLocal) argv.push('--keep-local');
  argv.push('--', ...targets);
  const output = await runSvn(argv, { cwd, timeout: 120000 });
  return { output };
}

async function svnMkdir(cwd, args) {
  const targets = requirePaths(args, cwd);
  const argv = ['mkdir', '--non-interactive'];
  if (args.parents) argv.push('--parents');
  argv.push('--', ...targets);
  const output = await runSvn(argv, { cwd, timeout: 60000 });
  return { output };
}

async function svnPropget(cwd, args) {
  if (!args.name) throw badRequest('name is required');
  const target = resolveTargetAbs(args.path, cwd) ?? cwd;
  const argv = ['propget', args.name];
  if (args.recursive) argv.push('-R');
  argv.push('--', target);
  try {
    const output = await runSvn(argv, { cwd, timeout: 60000 });
    return { name: args.name, path: target, value: output, exists: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/200017|Property[^:]*not found|No such property/i.test(msg)) {
      return { name: args.name, path: target, value: '', exists: false };
    }
    throw error;
  }
}

async function svnPropset(cwd, args) {
  if (!args.name) throw badRequest('name is required');
  if (args.value === undefined || args.value === null) throw badRequest('value is required');
  const target = resolveTargetAbs(args.path, cwd) ?? cwd;
  const f = path.join(os.tmpdir(), `dsh-svn-prop-${randomUUID()}.txt`);
  try {
    await fs.writeFile(f, String(args.value), { encoding: 'utf8' });
    const argv = ['propset', args.name, '--encoding', 'utf-8', '-F', f];
    if (args.recursive) argv.push('-R');
    if (args.force) argv.push('--force');
    argv.push('--', target);
    const output = await runSvn(argv, { cwd, timeout: 60000 });
    return { output };
  } finally {
    await fs.rm(f, { force: true }).catch(() => {});
  }
}

/** Parse `svn proplist --xml` into structured entries. */
function parseProplist(xml) {
  const out = [];
  const re = /<target\s+path="([^"]*)"[^>]*>([\s\S]*?)<\/target>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const props = [];
    const pre = /<property\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/property>/g;
    let p;
    while ((p = pre.exec(m[2])) !== null) props.push({ name: p[1], value: unescapeXml(p[2].trim()) });
    out.push({ path: m[1], properties: props });
  }
  return out;
}

async function svnProplist(cwd, args) {
  const target = resolveTargetAbs(args.path, cwd) ?? cwd;
  const argv = ['proplist', '--xml'];
  if (args.verbose) argv.push('-v');
  argv.push('--', target);
  const xml = await runSvn(argv, { cwd, timeout: 60000 });
  return { entries: parseProplist(xml) };
}

async function svnPropdel(cwd, args) {
  if (!args.name) throw badRequest('name is required');
  const target = resolveTargetAbs(args.path, cwd) ?? cwd;
  const argv = ['propdel', args.name];
  if (args.recursive) argv.push('-R');
  argv.push('--', target);
  const output = await runSvn(argv, { cwd, timeout: 60000 });
  return { output };
}

/** Parse `svn blame --xml` into per-line entries. */
function parseBlame(xml) {
  const entries = [];
  const re = /<entry\s+line-number="(\d+)"[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[2];
    entries.push({
      line: Number(m[1]),
      revision: Number(tagAttr(body, 'commit', 'revision') ?? 0),
      author: tagText(body, 'author'),
      date: tagText(body, 'date'),
      text: tagText(body, 'line') ?? '',
    });
  }
  return entries;
}

async function svnBlame(cwd, args) {
  const target = resolveTargetAbs(args.path, cwd);
  if (!target) throw badRequest('path is required');
  const argv = ['blame', '--xml'];
  if (args.revision) argv.push('-r', args.revision);
  argv.push('--', target);
  const xml = await runSvn(argv, { cwd, timeout: 60000 });
  return { path: target, entries: parseBlame(xml) };
}

/** Parse `svn list --xml` into structured entries (name rides as <name> child). */
function parseList(xml) {
  const entries = [];
  const re = /<entry\s+kind="([^"]*)"[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[2];
    const size = tagText(body, 'size');
    const rev = tagAttr(body, 'commit', 'revision');
    entries.push({
      kind: m[1],
      name: tagText(body, 'name') ?? '',
      size: size !== undefined ? Number(size) : undefined,
      revision: rev !== undefined ? Number(rev) : undefined,
      author: tagText(body, 'author'),
      date: tagText(body, 'date'),
    });
  }
  return entries;
}

async function svnList(cwd, args) {
  const target = resolveTargetAbs(args.target, cwd) ?? cwd;
  const argv = ['list', '--xml'];
  if (args.recursive) argv.push('-R');
  argv.push('--', target);
  const xml = await runSvn(argv, { cwd, timeout: 60000 });
  return { target, entries: parseList(xml) };
}

/** Lazy-load node:sqlite (experimental API); null when unavailable. */
let sqliteDatabaseSync = undefined;
async function loadSqlite() {
  if (sqliteDatabaseSync === undefined) {
    try {
      sqliteDatabaseSync = (await import('node:sqlite')).DatabaseSync;
    } catch {
      sqliteDatabaseSync = null;
    }
  }
  return sqliteDatabaseSync;
}

/**
 * Read the BASE (repository) content of a working-copy file straight from
 * SVN's pristine store, without passing the (possibly exotic) path to
 * svn.exe — `svn cat`/`svn diff` mangle non-ANSI path arguments on Windows
 * (E155010), which made Chinese/U+2011 filenames look "not versioned".
 * Returns undefined when the node is not under version control (new file)
 * or the store is unavailable.
 */
async function baseContentFromPristine(cwd, target) {
  let wcroot;
  try {
    const xml = await runSvn(['info', '--xml', '--', cwd], { cwd, timeout: 30000 });
    wcroot = tagText(xml, 'wcroot-abspath');
  } catch {
    return undefined;
  }
  if (!wcroot) return undefined;
  const rel = path.relative(wcroot, target).split(path.sep).join('/');
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return undefined;
  const dbPath = path.join(wcroot, '.svn', 'wc.db');
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT checksum FROM NODES WHERE local_relpath = ? AND kind = ?').get(rel, 'file');
      const checksum = row?.checksum;
      if (typeof checksum === 'string' && checksum.startsWith('$sha1$')) {
        const sha = checksum.slice('$sha1$'.length);
        const p = path.join(wcroot, '.svn', 'pristine', sha.slice(0, 2), `${sha}.svn-base`);
        const buf = await fs.readFile(p);
        return decodeBuffer(buf);
      }
    } finally {
      db.close();
    }
  } catch {
    /* sqlite or store unavailable — caller falls back to svn cat */
  }
  return undefined;
}

async function svnCat(cwd, args) {
  if (!args.target) throw badRequest('target is required');
  const target = resolveTargetAbs(args.target, cwd);
  // Local working-copy file at BASE: read pristine directly (path-proof).
  if (!args.revision || args.revision === 'BASE') {
    const isLocal = await fs.access(target).then(() => true).catch(() => false);
    if (isLocal) {
      const base = await baseContentFromPristine(cwd, target).catch(() => undefined);
      if (base !== undefined) {
        return { target, content: base.slice(0, 100000), binary: false, truncated: base.length > 100000 || undefined };
      }
    }
  }
  const argv = ['cat'];
  if (args.revision) argv.push('-r', args.revision);
  argv.push('--', target);
  const raw = await new Promise((resolve, reject) => {
    execFile(SVN, argv, {
      cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60000, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`svn cat failed: ${decodeBuffer(stderr).trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
  const binary = raw.includes(0);
  const MAX = 100000;
  const truncated = raw.length > MAX;
  const content = binary ? '' : decodeBuffer(raw.subarray(0, MAX));
  return { target, content, binary, truncated: truncated || undefined };
}

async function svnCheckout(cwd, args) {
  if (!args.url) throw badRequest('url is required');
  const argv = ['checkout', '--non-interactive'];
  if (args.revision) argv.push('-r', args.revision);
  argv.push(args.url);
  if (args.path) argv.push(resolveTargetAbs(args.path, cwd));
  const output = await runSvn(argv, { cwd, timeout: 300000 });
  const m = output.match(/revision\s+(\d+)/i) ?? output.match(/版本\s*(\d+)/);
  return { revision: m ? Number(m[1]) : undefined, output };
}

async function svnSwitch(cwd, args) {
  if (!args.url) throw badRequest('url is required');
  const target = resolveTargetAbs(args.path, cwd) ?? cwd;
  const argv = ['switch', '--non-interactive'];
  if (args.revision) argv.push('-r', args.revision);
  if (args.ignoreAncestry) argv.push('--ignore-ancestry');
  argv.push(args.url, '--', target);
  const output = await runSvn(argv, { cwd, timeout: 300000 });
  const m = output.match(/revision\s+(\d+)/i) ?? output.match(/版本\s*(\d+)/);
  return { revision: m ? Number(m[1]) : undefined, output };
}

async function svnCopy(cwd, args) {
  if (!args.source || !args.destination) throw badRequest('source and destination are required');
  const argv = ['copy', '--non-interactive'];
  if (args.parents) argv.push('--parents');
  if (args.message) {
    return withMsgFile(args.message, (f) => {
      argv.push('--encoding', 'utf-8', '-F', f);
      argv.push(resolveTargetAbs(args.source, cwd), resolveTargetAbs(args.destination, cwd));
      return runSvn(argv, { cwd, timeout: 120000 }).then((output) => ({ output }));
    });
  }
  argv.push(resolveTargetAbs(args.source, cwd), resolveTargetAbs(args.destination, cwd));
  const output = await runSvn(argv, { cwd, timeout: 120000 });
  return { output };
}

async function svnMove(cwd, args) {
  if (!args.source || !args.destination) throw badRequest('source and destination are required');
  const argv = ['move', '--non-interactive'];
  if (args.message) {
    return withMsgFile(args.message, (f) => {
      argv.push('--encoding', 'utf-8', '-F', f);
      argv.push(resolveTargetAbs(args.source, cwd), resolveTargetAbs(args.destination, cwd));
      return runSvn(argv, { cwd, timeout: 120000 }).then((output) => ({ output }));
    });
  }
  argv.push(resolveTargetAbs(args.source, cwd), resolveTargetAbs(args.destination, cwd));
  const output = await runSvn(argv, { cwd, timeout: 120000 });
  return { output };
}

async function svnMerge(cwd, args) {
  if (!args.source) throw badRequest('source is required');
  const argv = ['merge', '--non-interactive'];
  if (args.dryRun) argv.push('--dry-run');
  if (args.revision) argv.push('-r', args.revision);
  argv.push(args.source);
  if (args.target) argv.push('--', resolveTargetAbs(args.target, cwd));
  const output = await runSvn(argv, { cwd, timeout: 300000 });
  return { dryRun: args.dryRun === true, output };
}

async function svnMergeinfo(cwd, args) {
  if (!args.source) throw badRequest('source is required');
  const argv = ['mergeinfo', '--show-revs', args.showMerged ? 'merged' : 'eligible', args.source];
  if (args.target) argv.push('--', resolveTargetAbs(args.target, cwd));
  const output = await runSvn(argv, { cwd, timeout: 60000 });
  return { showMerged: args.showMerged === true, output };
}

async function svnLock(cwd, args) {
  const targets = requirePaths(args, cwd);
  const argv = ['lock', '--non-interactive'];
  if (args.message) {
    return withMsgFile(args.message, (f) => {
      argv.push('--encoding', 'utf-8', '-F', f);
      argv.push('--', ...targets);
      return runSvn(argv, { cwd, timeout: 60000 }).then((output) => ({ output }));
    });
  }
  argv.push('--', ...targets);
  const output = await runSvn(argv, { cwd, timeout: 60000 });
  return { output };
}

async function svnUnlock(cwd, args) {
  const targets = requirePaths(args, cwd);
  const argv = ['unlock', '--non-interactive'];
  if (args.force) argv.push('--force');
  argv.push('--', ...targets);
  const output = await runSvn(argv, { cwd, timeout: 60000 });
  return { output };
}

async function svnChangelist(cwd, args) {
  const action = args.action ?? 'set';
  if (action === 'list') {
    // svn changelist has no --list in 1.14; changelist membership rides the
    // status XML as <changelist name="..."> blocks.
    const xml = await runSvn(['status', '--xml', '--', cwd], { cwd, timeout: 60000 });
    const changelists = [];
    const re = /<changelist\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/changelist>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const paths = [];
      const pre = /<entry\s+path="([^"]*)"[^>]*>/g;
      let p;
      while ((p = pre.exec(m[2])) !== null) paths.push(p[1]);
      changelists.push({ name: m[1], paths });
    }
    return { changelists };
  }
  if (action === 'remove') {
    const targets = requirePaths(args, cwd);
    const argv = ['changelist', '--remove', '--', ...targets];
    const output = await runSvn(argv, { cwd, timeout: 60000 });
    return { output };
  }
  if (!args.name) throw badRequest('name is required for action "set"');
  const targets = requirePaths(args, cwd);
  const argv = ['changelist', args.name, '--', ...targets];
  const output = await runSvn(argv, { cwd, timeout: 60000 });
  return { output };
}

async function svnImport(cwd, args) {
  if (!args.path || !args.url) throw badRequest('path and url are required');
  if (!args.message) throw badRequest('message is required');
  const target = resolveTargetAbs(args.path, cwd);
  return withMsgFile(args.message, (f) => {
    const argv = ['import', '--non-interactive', '--encoding', 'utf-8', '-F', f, '--', target, args.url];
    return runSvn(argv, { cwd, timeout: 300000 }).then((output) => {
      const m = output.match(/revision\s+(\d+)/i) ?? output.match(/版本\s*(\d+)/);
      return { revision: m ? Number(m[1]) : undefined, output };
    });
  });
}

async function svnExport(cwd, args) {
  if (!args.target) throw badRequest('target is required');
  const argv = ['export', '--non-interactive'];
  if (args.revision) argv.push('-r', args.revision);
  if (args.force) argv.push('--force');
  argv.push(resolveTargetAbs(args.target, cwd));
  if (args.path) argv.push(resolveTargetAbs(args.path, cwd));
  const output = await runSvn(argv, { cwd, timeout: 300000 });
  return { output };
}

async function svnRelocate(cwd, args) {
  if (!args.from || !args.to) throw badRequest('from and to are required');
  const target = resolveTargetAbs(args.path, cwd) ?? cwd;
  const argv = ['relocate', '--non-interactive', args.from, args.to, '--', target];
  const output = await runSvn(argv, { cwd, timeout: 60000 });
  return { output };
}

async function svnPatch(cwd, args) {
  if (!args.patchFile) throw badRequest('patchFile is required');
  const patchFile = resolveTargetAbs(args.patchFile, cwd);
  const argv = ['patch'];
  if (args.dryRun) argv.push('--dry-run');
  if (args.reverse) argv.push('--reverse-diff');
  argv.push('--', patchFile);
  const output = await runSvn(argv, { cwd, timeout: 120000 });
  return { output };
}

async function svnUpgrade(cwd, args) {
  const target = resolveTargetAbs(args.path, cwd) ?? cwd;
  const argv = ['upgrade', '--non-interactive', '--', target];
  const output = await runSvn(argv, { cwd, timeout: 60000 });
  return { output };
}

/** Merge a del-run with the following add-run into "modified" rows, pairing
 * them in order (k-th deleted line vs k-th added line). Pure inserts/deletes
 * keep their own rows. Result: changed lines keep both line numbers on ONE
 * horizontal line — left red / right green. */
function mergeModifiedPairs(pairs) {
  const out = [];
  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i];
    if (p.left && !p.right) {
      const dels = [];
      const adds = [];
      let j = i;
      while (j < pairs.length && pairs[j].left && !pairs[j].right) { dels.push(pairs[j]); j++; }
      while (j < pairs.length && !pairs[j].left && pairs[j].right) { adds.push(pairs[j]); j++; }
      const k = Math.min(dels.length, adds.length);
      for (let d = 0; d < k; d++) out.push({ left: dels[d].left, right: adds[d].right, modified: true });
      for (let d = k; d < dels.length; d++) out.push(dels[d]);
      for (let d = k; d < adds.length; d++) out.push(adds[d]);
      i = j;
      continue;
    }
    out.push(p);
    i++;
  }
  return out;
}

/** Split text into lines; drop the trailing empty element from a final newline. */
function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS-based line alignment producing {left, right} row pairs for a side-by-side diff. */
function alignLines(a, b) {
  const n = a.length;
  const m = b.length;
  const MAX = 2500;
  if (n > 5000 || m > 5000 || n * m > MAX * MAX) return naiveAlign(a, b);
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({ left: { no: i + 1, text: a[i] }, right: { no: j + 1, text: b[j] } });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      pairs.push({ left: { no: i + 1, text: a[i] }, right: null });
      i++;
    } else {
      pairs.push({ left: null, right: { no: j + 1, text: b[j] } });
      j++;
    }
  }
  while (i < n) { pairs.push({ left: { no: i + 1, text: a[i] }, right: null }); i++; }
  while (j < m) { pairs.push({ left: null, right: { no: j + 1, text: b[j] } }); j++; }
  return pairs;
}

/** Cheap fallback for very large inputs: equal prefix/suffix + one change block. */
function naiveAlign(a, b) {
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length && a[i] === b[j]) {
    pairs.push({ left: { no: i + 1, text: a[i] }, right: { no: j + 1, text: b[j] } });
    i++;
    j++;
  }
  let ei = a.length;
  let ej = b.length;
  while (ei > i && ej > j && a[ei - 1] === b[ej - 1]) { ei--; ej--; }
  for (let k = i; k < ei; k++) pairs.push({ left: { no: k + 1, text: a[k] }, right: null });
  for (let k = j; k < ej; k++) pairs.push({ left: null, right: { no: k + 1, text: b[k] } });
  while (ei < a.length && ej < b.length && a[ei] === b[ej]) {
    pairs.push({ left: { no: ei + 1, text: a[ei] }, right: { no: ej + 1, text: b[ej] } });
    ei++;
    ej++;
  }
  return pairs;
}

/** Render aligned pairs as a classic unified diff text (no context lines). */
function pairsToUnified(pairs, label, rev, rightLabel) {
  const out = [];
  out.push(`Index: ${label}`);
  out.push('===================================================================');
  out.push(`--- ${label}\t(revision ${rev || 'BASE'})`);
  out.push(`+++ ${label}\t(${rightLabel || 'working copy'})`);
  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i];
    if (p.left && p.right && !p.modified) { i++; continue; }
    // one change run → one hunk
    const first = p.left ? p.left.no : (p.right ? p.right.no : 1);
    const oldStart = p.left ? p.left.no : first;
    const newStart = p.right ? p.right.no : first;
    let oldCount = 0;
    let newCount = 0;
    const body = [];
    let j = i;
    while (j < pairs.length) {
      const q = pairs[j];
      if (q.left && q.right && !q.modified) break;
      if (q.left) oldCount++;
      if (q.right) newCount++;
      if (q.left) body.push(`-${q.left.text}`);
      if (q.right) body.push(`+${q.right.text}`);
      j++;
    }
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...body);
    i = j;
  }
  return out.join('\n');
}

/** svn diff fails on paths with exotic Unicode chars (E155010, svn 1.14);
 * fall back to file-based side reads so the tool never breaks on those. */
async function diffWithFallback(cwd, target, revision) {
  try {
    const argv = ['diff'];
    if (revision) argv.push('-r', revision);
    argv.push('--', target);
    return await runSvn(argv, { cwd, timeout: 120000 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/E155010|not found|E155007/i.test(msg)) throw error;
    const sides = await readSides(cwd, target);
    if (sides.binary) return '(二进制文件，无法生成文本 diff)';
    const pairs = mergeModifiedPairs(alignLines(splitLines(sides.left ?? ''), splitLines(sides.right ?? '')));
    let rev;
    try {
      const xml = await runSvn(['info', '--xml', '--', target], { cwd, timeout: 30000 });
      rev = tagAttr(xml, 'entry', 'revision');
    } catch { /* unknown */ }
    return pairsToUnified(pairs, target, rev);
  }
}

/**
 * Prepare explicit commit targets so `svn commit` never fails on them:
 * - files versioned in the wc but missing on disk  → `svn delete` (missing)
 * - files present on disk but NOT versioned       → `svn add` (unversioned)
 * Status is probed per parent dir (ASCII param) and matched by absolute path.
 *
 * Both repairs are switchable (Settings → 提交): with one disabled those paths
 * are reported in `skipped` instead of being touched, so the caller can commit
 * the rest and tell the user which files still need a manual `svn add` /
 * `svn delete`. Nothing here ever commits.
 */
async function prepareForCommit(cwd, targets) {
  const settings = svnSettings();
  const added = [];
  const deleted = [];
  const skipped = [];
  const statusByPath = new Map();
  const dirs = [...new Set(targets.map((t) => path.dirname(t)))];
  for (const dir of dirs) {
    try {
      // absolute dir arg → status XML entries carry absolute paths (same shape as targets)
      const xml = await runSvn(['status', '--xml', '--', dir], { cwd, timeout: 60000 });
      for (const e of parseStatus(xml)) statusByPath.set(e.path.toLowerCase(), e.status);
    } catch { /* dir probe failed — fall through to per-file behavior below */ }
  }
  for (const t of targets) {
    const exists = await fs.access(t).then(() => true).catch(() => false);
    const item = statusByPath.get(t.toLowerCase());
    if (!exists && item === '!') {
      if (settings.autoDeleteMissing === false) {
        skipped.push({ path: t, reason: 'missing' });
        continue;
      }
      await runSvn(['delete', '--non-interactive', '--', t], { cwd, timeout: 60000 }).catch(() => {});
      deleted.push(t);
    } else if (exists && (item === '?' || item === undefined)) {
      if (settings.autoAddUnversioned === false) {
        skipped.push({ path: t, reason: 'unversioned' });
        continue;
      }
      try {
        await runSvn(['add', '--non-interactive', '--', t], { cwd, timeout: 60000 });
        added.push(t);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // already versioned: not an error for the commit itself
        if (/caught by ignore|ignored/i.test(msg)) {
          throw Object.assign(new Error(`文件被忽略规则排除，无法添加: ${t}`), { code: 'ignored', status: 400 });
        }
        if (!/E200009|E155007|E155000|already under version control/i.test(msg)) throw error;
      }
    }
  }
  return { added, deleted, skipped };
}

/** Read both sides for one target: BASE via svn cat, working copy from disk. */
/** "svn://host/a/b" -> "/a/b" (no URL parsing needed for svn: URLs). */
function urlPathname(u) {
  const s = String(u ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = s.indexOf('/');
  return slash === -1 ? '' : s.slice(slash);
}

/** Read the repository bytes of a versioned working-copy path straight from
 * SVN's pristine store. `.svn/pristine` holds exactly the content of the newly
 * checked-out node, keyed by the SHA-1 recorded in `NODES`, so this is a
 * genuine server-content read that never contacts the repository — the offline
 * path for "the version this working copy currently holds".
 *
 * `wantedRev` is compared against the node's LAST-CHANGED revision (the
 * revision whose content the pristine actually is), which is stricter and
 * safer than the BASE revision: a file checked out at r816 may well have
 * existed unchanged since r700, in which case its pristine content IS r700.
 *
 * `svn info` on the target is the fast path, but a non-ASCII path is mangled
 * by svn.exe's Windows argv (W155010/E200009), so on failure the working-copy
 * root is taken from the ASCII workspace directory and the target is resolved
 * by walking up its parent chain inside wc.db.
 *
 * Returns { content, revision } or null (not under version control, no
 * pristine, or too ambiguous to answer safely). */
async function pristineContentAt(cwd, absPath, wantedRev, wcrootHint) {
  let wcroot = wcrootHint;
  // Resolve the node's repository-relative path inside the working copy.
  let rel = null;
  try {
    const xml = await runSvn(['info', '--xml', '--', absPath], { cwd, timeout: 30000 });
    const root = tagText(xml, 'wcroot-abspath') ?? wcroot;
    if (!root) return null;
    wcroot = root;
    rel = path.relative(root, absPath).split(path.sep).join('/');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/E155010|E200009|W155010|not found|系统找不到|参数错误/i.test(msg)) return null;
    if (wcroot === undefined) {
      try {
        const xml = await runSvn(['info', '--xml', '--', cwd], { cwd, timeout: 30000 });
        wcroot = tagText(xml, 'wcroot-abspath');
      } catch { return null; }
    }
    if (!wcroot) return null;
    // Walk up until the path is inside the working copy (the node itself may
    // be missing from disk or from wc.db while an ancestor has a row).
    let probe = await fs.access(absPath).then(() => absPath).catch(() => path.dirname(absPath));
    for (let hops = 0; hops < 64; hops++) {
      const candidate = path.relative(wcroot, probe).split(path.sep).join('/');
      if (candidate === '' || candidate.startsWith('..')) break;
      const resolved = await pristineForRel(wcroot, candidate, wantedRev);
      if (resolved !== null) return resolved;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    return null;
  }
  if (rel === null || rel === '' || rel.startsWith('..')) return null;
  return await pristineForRel(wcroot, rel, wantedRev);
}

/** Resolve one working-copy-relative node to its pristine bytes, walking up
 * the parent chain when the node itself has no row/checksum (directories have
 * none; a node missing from disk may have lost its row too). `wc.db` stores
 * `local_relpath` with '/' separators on every platform, so the target is
 * normalized first.
 *
 * The pristine is only returned when the node's LAST-CHANGED revision (or,
 * as a fallback, its checked-out revision) equals `wantedRev`; the working
 * copy holds exactly ONE version of a file, so answering a different revision
 * from the store would silently show the wrong content. Revisions this method
 * cannot prove therefore answer null, and the caller reports them as
 * unavailable instead of guessing. Returns { content, revision } or null. */
async function pristineForRel(wcroot, targetRel, wantedRev) {
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return null;
  const start = String(targetRel).split(path.sep).join('/').replace(/^\/+/, '');  if (start === '') return null;
  if (wantedRev === undefined || wantedRev === null) return null;
  try {
    const db = new DatabaseSync(path.join(wcroot, '.svn', 'wc.db'), { readOnly: true });
    try {
      let node = start;
      let row;
      for (;;) {
        row = db.prepare('SELECT checksum, revision, changed_revision FROM NODES WHERE local_relpath = ? AND op_depth = 0').get(node);
        if (row !== undefined) break;
        const parent = node.includes('/') ? node.slice(0, node.lastIndexOf('/')) : '';
        if (parent === '') return null;
        node = parent;
      }
      const wanted = Number(wantedRev);
      const changed = row.changed_revision !== undefined && row.changed_revision !== null
        ? Number(row.changed_revision)
        : null;
      const checkedOut = row.revision !== undefined && row.revision !== null ? Number(row.revision) : null;
      // Which revision this pristine really is: the last-changed revision is
      // exact; the checked-out revision is only a safe answer when they match
      // (i.e. the file was actually modified in the revision we hold).
      const revision = changed !== null ? changed : (checkedOut === wanted ? checkedOut : null);
      if (revision === null || revision !== wanted) return null;
      const checksum = row.checksum;
      if (typeof checksum !== 'string' || !checksum.startsWith('$sha1$')) return null;
      const sha = checksum.slice('$sha1$'.length);
      const file = path.join(wcroot, '.svn', 'pristine', sha.slice(0, 2), `${sha}.svn-base`);
      return { content: await fs.readFile(file), revision };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** First 8 KB NUL probe (bounded memory) — mirrors the binary check in
 * catToTemp for locally produced temp files. */
async function tempFileIsBinary(file) {
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

/** `svn cat` one repository URL at revision `rev` (peg = `rev`), streaming
 * stdout into a fresh temp file so arbitrarily large files (big .uasset
 * binaries) never hit execFile's maxBuffer. Probes only the first 8 KB for
 * NUL bytes. Resolves { temp, binary, offline }; the caller owns `temp` and
 * must unlink it. The URL's non-ASCII segments must already be percent-encoded
 * so exotic (Chinese / U+2011) paths never hit svn.exe's Windows argv
 * (E155010). Rejects when the path does not exist at that revision.
 *
 * With `offlineOk`, a request for the version the working copy itself holds is
 * answered from the local pristine store when the server cannot serve it, and
 * a revision this method cannot prove locally resolves to null instead of
 * throwing, so callers degrade to "this version is not available locally". */
async function catToTemp(cwd, url, rev, opts = {}) {
  const wantOffline = opts.offlineOk === true;
  const local = wantOffline && opts.wcAbs
    ? await pristineContentAt(cwd, opts.wcAbs, rev).catch(() => null)
    : null;
  if (local !== null) {
    const temp = path.join(os.tmpdir(), `dsh-svn-cat-${randomUUID()}.tmp`);
    await fs.writeFile(temp, local.content);
    return { temp, binary: local.content.subarray(0, 8192).includes(0), offline: true };
  }
  const temp = path.join(os.tmpdir(), `dsh-svn-cat-${randomUUID()}.tmp`);
  const stderrChunks = [];
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(SVN, ['cat', '--non-interactive', '-r', String(rev), `${url}@${rev}`], {
        cwd, windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('svn cat 超时（10 分钟）'));
      }, 10 * 60 * 1000);
      const out = createWriteStream(temp);
      child.stdout.pipe(out);
      child.stderr.on('data', (d) => { if (stderrChunks.length < 256) stderrChunks.push(d); });
      out.on('error', (err) => { clearTimeout(timer); child.kill(); reject(err); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(decodeBuffer(Buffer.concat(stderrChunks)).trim() || `svn cat failed with exit code ${code}`));
        } else {
          resolve();
        }
      });
    });
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    if (wantOffline && isTransportError(error)) return null;
    throw error;
  }
  // binary probe: first 8 KB only (bounded memory)
  return { temp, binary: await tempFileIsBinary(temp), offline: false };
}

/** Text-decoded wrapper of catToTemp for the history diff view. Binary or
 * oversized files resolve { binary: true } without a full decode; callers
 * must unlink `temp`. With `offlineOk` an unavailable revision (server
 * unreachable and not the local BASE) resolves to null instead of throwing,
 * so the rN↔rN-1 comparison can still show whichever side exists locally. */
async function catUrl(cwd, url, rev, opts = {}) {
  const got = await catToTemp(cwd, url, rev, opts);
  if (got === null) return null;
  const { temp, binary } = got;
  try {
    if (binary) return { binary: true, raw: null, text: null, temp };
    const stat = await fs.stat(temp);
    if (stat.size > 64 * 1024 * 1024) {
      return { binary: true, raw: null, text: null, temp };
    }
    const raw = await fs.readFile(temp);
    return { binary: false, raw, text: decodeBuffer(raw), temp };
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

/** Streaming SHA-1 of a file (bounded memory). */
function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    const s = createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Byte-equality of two (possibly huge) files, checked by size + SHA-1. */
async function filesEqual(a, b) {
  const stats = await Promise.all([fs.stat(a), fs.stat(b)]).catch(() => null);
  if (!stats || stats[0].size !== stats[1].size) return false;
  const [ha, hb] = await Promise.all([sha1File(a), sha1File(b)]);
  return ha === hb;
}

/** Resolve a repo-relative path (e.g. `/trunk/a/b`) against the working
 * copy: returns the percent-encoded repository URL (segments encoded so
 * exotic Chinese/U+2011 names never reach svn.exe's Windows argv, E155010)
 * and the file's absolute working-copy path. Containment rule mirrors the
 * client's clickable check — suffix '' means the working copy IS the
 * repository root. Shared by the history diff and the history revert. */
async function repoRelTarget(cwd, repoRel) {
  if (typeof repoRel !== 'string' || !repoRel.startsWith('/')) {
    throw badRequest('repoRel (absolute repo path) is required');
  }
  const xml = await runSvn(['info', '--xml', '--', cwd], { cwd, timeout: 30000 });
  const info = parseInfo(xml, cwd);
  if (!info.repositoryRoot || !info.url) throw new Error('无法解析工作副本 URL');
  const rootPath = urlPathname(info.repositoryRoot);
  const wcPath = urlPathname(info.url);
  const suffix = rootPath !== '' && wcPath.startsWith(rootPath) ? wcPath.slice(rootPath.length) : '';
  if (!(suffix === '' || repoRel.startsWith(suffix + '/'))) {
    throw badRequest(`路径不在当前工作副本内：${repoRel}`);
  }
  const url = info.repositoryRoot.replace(/\/+$/, '') + repoRel.split('/').map(encodeURIComponent).join('/');
  const rel = suffix === '' ? repoRel.slice(1) : repoRel.slice(suffix.length + 1);
  const wcAbs = path.resolve(cwd, rel.replace(/^[/\\]+/, ''));
  return { url, wcAbs };
}

async function readSides(cwd, target) {
  let left = null;
  let leftMissing = false;
  try {
    const l = await svnCat(cwd, { target, revision: 'BASE' });
    if (l.binary) return { binary: true };
    left = l.content;
  } catch { leftMissing = true; }
  let right = null;
  let rightMissing = false;
  try {
    const buf = await fs.readFile(target);
    if (buf.includes(0)) return { binary: true };
    right = decodeBuffer(buf);
  } catch { rightMissing = true; }
  return { binary: false, left, right, leftMissing, rightMissing };
}

// --------------------------------------------------- offline (server down)
// The SVN *server* can be unreachable while the working copy stays perfectly
// usable. `svn` itself only ever falls back to local data for a few
// subcommands (status/diff/revert/...); `svn log` ALWAYS contacts the
// repository, so commit history is unavailable offline. To keep the panel
// useful when the server is down (as TortoiseSVN does, with the warning that
// such data may be incomplete or misleading) this layer provides:
//   1. a log cache — every successful remote `svn log` is persisted next to
//      the working copy, so a later offline run can still show real messages,
//      authors, dates and (verbose) changed paths;
//   2. a local revision snapshot — `changed_revision`/`changed_author`/
//      `changed_date` per node in `.svn/wc.db` reconstruct WHICH paths each
//      revision touched (commit-message text is not stored in the working
//      copy, so those rows are explicitly flagged `messageKnown: false`).
// Nothing here ever contacts the network, and no offline state is permanent:
// the panel switches back to online data the moment a query succeeds.

/** Long-lived view of the WC's repository, cached per working-copy root. */
const infoCache = new Map();

async function wcInfo(cwd, opts = {}) {
  const key = String(cwd ?? '');
  const ttl = opts.ttl ?? 5000;
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.info;
  const xml = await runSvn(['info', '--xml', '--', cwd], { cwd, timeout: 30000 });
  const info = parseInfo(xml, cwd);
  infoCache.set(key, { at: Date.now(), info });
  return info;
}

/** Transport-level failures (server unreachable), as opposed to "the path
 * does not exist" / permission / usage errors that must still surface. */
function isTransportError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return /E170013|E210005|E175002|E0000\d\d|Unable to connect to a repository|No repository found|Connection (?:refused|timed out|reset)|could not connect to server|无法连接|不能连接到服务器|连接被拒绝|连接超时/i.test(msg);
}

/** The svn:// server answered but has no repository at that path
 * (E210005 "No repository found"). Distinct from an unreachable server: the
 * svnserve greeting proves the port is alive, so this usually means the
 * repository was renamed/deleted or the account's repositories were removed /
 * suspended. It still leaves the working copy fully usable, so the panel
 * offers the same offline fallback but must not pretend it is a network
 * hiccup. */
function isRepositoryMissingError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return /E210005|No repository found|没有(?:找到|名为).*版本库|不存在.*版本库/i.test(msg);
}

/** /svn/api/* methods that modify the repository or the working copy; used to
 * enforce the panel's 只读模式 on the server side too. Kept in both URL form
 * (kebab) and handler form (camel) so either spelling is caught. */
const WRITE_API_METHODS = new Set([
  'add', 'revert', 'delete', 'mkdir', 'cleanup', 'resolve', 'commit',
  'generate-message', 'generateMessage', 'diff-choose', 'diffChoose',
  'import', 'patch', 'upgrade', 'history-revert', 'historyRevert',
  'update', 'update-start', 'updateStart', 'switch', 'checkout', 'relocate',
  'copy', 'move', 'merge', 'lock', 'unlock', 'propset', 'propdel', 'changelist',
]);

/* ------------------------------------------------------------- log cache */
// Stored as `.svn/dsh-history-cache.json` — deliberately INSIDE .svn: it is
// SVN-internal state, invisible to `svn status`, and travels with the
// working copy instead of polluting the user profile. Falls back to a
// per-user cache directory when .svn is read-only or absent.
const HISTORY_CACHE_VERSION = 1;
const HISTORY_CACHE_MAX_ENTRIES = 20000;

async function historyCacheFile(cwd) {
  const fallbacks = [];
  try {
    const info = await wcInfo(cwd, { ttl: 60000 });
    if (info.workingCopyRoot) fallbacks.push(path.join(info.workingCopyRoot, '.svn', 'dsh-history-cache.json'));
    fallbacks.push(path.join(info.workingCopyRoot, '.svn'));
  } catch { /* not a working copy */ }
  const base = process.env.LOCALAPPDATA ?? os.homedir();
  const key = String(cwd ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-60);
  if (key !== '') fallbacks.push(path.join(base, 'dsh-svn-tools', 'history', `${key}.json`));
  for (const file of fallbacks) {
    if (!file.endsWith('.json')) continue;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.access(path.dirname(file));
      return file;
    } catch { /* try the next location */ }
  }
  return null;
}

async function readHistoryCache(cwd) {
  if (svnSettings().historyCacheEnabled === false) return { entries: {} };
  try {
    const file = await historyCacheFile(cwd);
    if (!file) return { entries: {} };
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || parsed.version !== HISTORY_CACHE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { entries: {} };
    }
    const entries = {};
    for (const [rev, e] of Object.entries(parsed.entries)) {
      const n = Number(rev);
      if (Number.isInteger(n) && n > 0 && e !== null && typeof e === 'object') entries[n] = e;
    }
    return { repoUrl: parsed.repoUrl, fetchedAt: parsed.fetchedAt, entries };
  } catch {
    return { entries: {} };
  }
}

async function writeHistoryCache(cwd, state) {
  if (svnSettings().historyCacheEnabled === false) return false;
  try {
    const file = await historyCacheFile(cwd);
    if (!file) return false;
    const settings = svnSettings();
    const maxEntries = Number.isInteger(settings.historyCacheMaxEntries) && settings.historyCacheMaxEntries > 0
      ? settings.historyCacheMaxEntries
      : HISTORY_CACHE_MAX_ENTRIES;
    const revisions = Object.keys(state.entries).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => b - a);
    const entries = {};
    for (const rev of revisions.slice(0, maxEntries)) entries[rev] = state.entries[rev];
    const out = {
      version: HISTORY_CACHE_VERSION,
      repoUrl: state.repoUrl,
      fetchedAt: state.fetchedAt ?? Date.now(),
      entries,
    };
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(out), 'utf8');
    await fs.rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Normalize one log entry for the wire: the client only needs revision,
 * author, date, message and (verbose) changed paths. */
function normalizeLogEntry(e, source) {
  const paths = Array.isArray(e?.paths)
    ? e.paths
      .filter((p) => p && typeof p.path === 'string')
      .map((p) => ({ action: p.action ?? 'M', kind: p.kind ?? 'file', path: p.path }))
    : [];
  return {
    revision: Number(e?.revision),
    author: e?.author ?? '',
    date: e?.date ?? '',
    message: typeof e?.message === 'string' ? e.message : '',
    paths: paths.length > 0 ? paths : undefined,
    source,
    // The commit-message TEXT exists only for entries that came from the
    // repository (or from our cache of it). Revisions rebuilt from wc.db have
    // no message at all — the client renders an explanation instead.
    messageKnown: source !== 'local',
  };
}

/* -------------------------------------- local revision snapshot (wc.db) */

/** Reconstruct a commit list from the working copy's own metadata:
 * every node records the revision/author/date that last changed it, so
 * grouping by `changed_revision` yields the paths each revision touched.
 * Commit-message TEXT is not stored in the working copy (SVN keeps it
 * server-side only) — those entries carry `message: ''` and
 * `messageKnown: false`. Deleted paths cannot be reconstructed either. */
async function readLocalRevisionHistory(cwd) {
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return null;
  let prefix = '';
  let dbPath;
  let localRevision = null;
  try {
    const info = await wcInfo(cwd, { ttl: 5000 });
    const wcroot = info.workingCopyRoot;
    if (!wcroot) return null;
    dbPath = path.join(wcroot, '.svn', 'wc.db');
    localRevision = info.revision !== undefined && info.revision !== '' ? Number(info.revision) : null;
    const url = String(info.url ?? '');
    const root = String(info.repositoryRoot ?? '');
    if (root !== '' && url.startsWith(root)) prefix = url.slice(root.length).replace(/^\/+/, '');
  } catch {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    // node:sqlite (Node 22+) returns strings by default; be tolerant of
    // BLOB/ArrayBuffer rows from older builds.
    const text = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'string') return v;
      if (v instanceof Uint8Array) return decodeBuffer(Buffer.from(v));
      return String(v);
    };
    const rows = db.prepare(
      'SELECT repos_path, changed_revision, changed_author, changed_date, kind, presence '
      + 'FROM NODES WHERE op_depth = ? AND repos_path IS NOT NULL AND changed_revision >= ?',
    ).all(0, 1);
    const byRev = new Map();
    for (const row of rows) {
      const reposPath = text(row.repos_path);
      if (reposPath === null) continue;
      if (prefix !== '' && reposPath !== prefix && !reposPath.startsWith(`${prefix}/`)) continue;
      const rev = Number(row.changed_revision);
      if (!Number.isInteger(rev) || rev < 1) continue;
      let group = byRev.get(rev);
      if (group === undefined) {
        const ts = Number(row.changed_date);
        group = {
          revision: rev,
          author: text(row.changed_author) ?? '',
          date: Number.isFinite(ts) && ts > 0 ? new Date(ts / 1000).toISOString() : '',
          paths: [],
        };
        byRev.set(rev, group);
      }
      // Raw DB bytes are UTF-8 in current SVN builds; `decodeURIComponent`
      // also repairs the escaped form older builds stored for non-ASCII
      // names (and throws on a literal '%', which we then keep verbatim).
      let decoded = reposPath;
      try { decoded = decodeURIComponent(reposPath); } catch { /* literal % */ }
      const kind = text(row.kind) ?? 'file';
      group.paths.push({
        // exact action type (A/D/M/R) is not recoverable locally
        action: 'M',
        kind,
        path: `/${decoded}`,
        reconstructed: true,
      });
    }
    const entries = [...byRev.values()].sort((a, b) => b.revision - a.revision);
    return { localRevision, entries, available: true };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** The offline history list: cached server entries first (message/author/
 * date/changed paths are real), then locally reconstructed revisions the
 * cache does not know about. */
async function localHistoryEntries(cwd, { limit, olderThan }) {
  const cache = await readHistoryCache(cwd);
  const local = await readLocalRevisionHistory(cwd);
  const cachedRevs = Object.keys(cache.entries).map(Number);
  const merged = new Map();
  for (const rev of cachedRevs) {
    const e = cache.entries[rev];
    if (e === null || typeof e !== 'object') continue;
    merged.set(Number(rev), normalizeLogEntry(e, 'cache'));
  }
  for (const e of local?.entries ?? []) {
    if (merged.has(e.revision)) continue;
    merged.set(e.revision, Object.assign(normalizeLogEntry(e, 'local'), { reconstructed: true }));
  }
  const all = [...merged.values()].filter((e) => Number.isInteger(e.revision) && e.revision > 0);
  const wanted = typeof olderThan === 'number' && Number.isInteger(olderThan)
    ? all.filter((e) => e.revision < olderThan)
    : all;
  wanted.sort((a, b) => b.revision - a.revision);
  const page = wanted.slice(0, limit);
  return {
    entries: page,
    localRevision: local?.localRevision ?? null,
    hasSnapshot: local !== null,
    cachedRevisions: cachedRevs.length,
    cachedAt: cache.fetchedAt ?? null,
    newestCached: cachedRevs.length > 0 ? Math.max(...cachedRevs) : null,
  };
}

/** Per-repository result of the last operation that needed the SVN server;
 * surfaced so the panel can explain WHY it is showing local data. */
const connState = new Map();

function connKey(info) {
  return info?.repositoryUuid !== undefined && info.repositoryUuid !== ''
    ? info.repositoryUuid
    : String(info?.repositoryRoot ?? '');
}

function markConn(info, ok, error) {
  const key = connKey(info);
  if (key === '') return;
  const previous = connState.get(key);
  connState.set(key, {
    ok,
    at: Date.now(),
    error: ok ? undefined : (error instanceof Error ? error.message : (error === undefined ? undefined : String(error))),
    since: ok ? undefined : (previous && previous.ok === false ? previous.since : Date.now()),
  });
}

function connFor(info) {
  const key = connKey(info);
  const st = key === '' ? undefined : connState.get(key);
  return {
    reachable: st === undefined ? null : st.ok,
    checkedAt: st?.at ?? null,
    error: st?.error ?? null,
    errorSince: st?.since ?? null,
  };
}

/** All API methods, keyed by URL suffix. Every payload carries sessionId (+ optional cwd). */
function buildApi(ctx) {
  const api = {};

  api.root = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const xml = await runSvn(['info', '--xml', '--', cwd], { cwd, timeout: 30000 });
    // `settings` is the resolved namespace (schema defaults + user layer) and
    // `settingsUser` names the fields the user overrode. The panel uses them as
    // the baseline for its own preferences, so it behaves as configured even
    // when the client-side settings scope is not available in this build.
    return { cwd, ...parseInfo(xml, cwd), settings: svnSettings(), settingsUser: svnSettingsUserLayer() };
  };

  /** Probe the `svn` executable the settings point at — the card's 「检测」
   * button writes the draft path here before persisting it, so a typo is
   * reported instead of silently breaking every later call. Read-only: it runs
   * `svn --version --quiet` and never touches the working copy. */
  api.checkSvn = async (p) => {
    const requested = typeof p?.path === 'string' && p.path.trim() !== '' ? p.path.trim() : null;
    const binary = requested ?? svnBinary();
    const started = Date.now();
    try {
      const version = await runSvnWith(binary, ['--version', '--quiet'], { timeout: 15000 });
      return { ok: true, binary, version: version.trim(), elapsedMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        binary,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - started,
      };
    }
  };

  /** Remote HEAD revision of the working copy's repository, so the UI can
   * tell whether there are newer commits than the local working-copy
   * revision. Uses `svn info -r HEAD` (contacts the repository) and returns
   * only the fields the history page needs. When the server is unreachable
   * the local revision is still reported (with `remote: false`) instead of
   * failing the whole history page. */
  api.headInfo = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const local = await localRevisionOf(cwd); // svnversion/info — local only
    try {
      const xml = await runSvn(['info', '--xml', '-r', 'HEAD', '--', cwd], { cwd, timeout: 60000 });
      const entry = xml.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/);
      const body = entry ? entry[1] : xml;
      const headRevision = Number(tagAttr(xml, 'entry', 'revision') ?? 0);
      let info;
      try { info = await wcInfo(cwd); } catch { /* keep the mark keyless */ }
      markConn(info, true);
      return {
        remote: true,
        headRevision: headRevision,
        localRevision: local.localRevision,
        localMin: local.localMin,
        mixed: local.mixed,
        hasMods: local.hasMods,
        raw: local.raw,
        lastChangedRevision: tagAttr(body, 'commit', 'revision'),
        lastChangedAuthor: tagText(body, 'author'),
        lastChangedDate: tagText(body, 'date'),
      };
    } catch (error) {
      if (!isTransportError(error)) throw error;
      let info;
      try { info = await wcInfo(cwd); } catch { /* keep the mark keyless */ }
      markConn(info, false, error);
      const cache = await readHistoryCache(cwd);
      const cachedRevs = Object.keys(cache.entries).map(Number);
      const newestCached = cachedRevs.length > 0 ? Math.max(...cachedRevs) : null;
      return {
        remote: false,
        headRevision: null,
        newestCached: newestCached,
        cachedAt: cache.fetchedAt ?? null,
        localRevision: local.localRevision,
        localMin: local.localMin,
        mixed: local.mixed,
        hasMods: local.hasMods,
        raw: local.raw,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  api.status = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd) ?? cwd;
    const xml = await runSvn(['status', '--xml', '--', target], { cwd, timeout: 60000 });
    const entries = parseStatus(xml);
    const summary = {};
    for (const e of entries) summary[e.status] = (summary[e.status] ?? 0) + 1;
    return { count: entries.length, summary, entries };
  };

  /** All locked (occupied) files in the working copy, with owner/comment/
   * timestamp — `svn status -u` contacts the repository for lock state.
   * Locks held by THIS working copy (mine) are detected with a plain
   * `svn status --xml` (no -u): its <lock> sits under <wc-status> and only
   * appears for locally-held locks. When the server is unreachable the
   * local locks are still listed and `offline: true` is reported instead of
   * failing the whole page. */
  api.locks = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd) ?? cwd;
    const localXml = await runSvn(['status', '--xml', '--', target], { cwd, timeout: 60000 });
    const localPaths = new Set(parseLocks(localXml).map((e) => e.path));
    let allXml;
    let info;
    try {
      allXml = await runSvn(['status', '--xml', '-u', '--', target], { cwd, timeout: 180000 });
    } catch (error) {
      if (!isTransportError(error)) throw error;
      try { info = await wcInfo(cwd); } catch { /* keep the mark keyless */ }
      markConn(info, false, error);
      const entries = parseLocks(localXml).map((e) => Object.assign(e, { mine: localPaths.has(e.path) || undefined }));
      return {
        entries,
        offline: true,
        note: '离线数据：仅显示本工作副本持有的锁；其他占用者需要连接服务器才能查询。',
      };
    }
    try { info = await wcInfo(cwd); } catch { /* keep the mark keyless */ }
    markConn(info, true);
    const entries = parseLocks(allXml).map((e) => Object.assign(e, { mine: localPaths.has(e.path) || undefined }));
    return { entries, offline: false };
  };

  api.diff = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd);
    if (!target) throw Object.assign(new Error('path is required'), { code: 'bad-request', status: 400 });
    const diff = await diffWithFallback(cwd, target, p.revision);
    return { diff };
  };

  api.diffSides = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd);
    if (!target) throw Object.assign(new Error('path is required'), { code: 'bad-request', status: 400 });
    const sides = await readSides(cwd, target);
    if (sides.binary) return { path: target, binary: true, message: '二进制文件，无法左右对比' };
    let revision;
    try {
      const xml = await runSvn(['info', '--xml', '--', target], { cwd, timeout: 30000 });
      revision = tagAttr(xml, 'entry', 'revision');
    } catch { /* revision unknown */ }
    const pairs = mergeModifiedPairs(alignLines(splitLines(sides.left ?? ''), splitLines(sides.right ?? '')));
    return {
      path: target,
      revision,
      binary: false,
      leftMissing: sides.leftMissing,
      rightMissing: sides.rightMissing,
      leftLabel: sides.leftMissing ? '（新增文件，无版本库版本）' : (revision ? `r${revision}` : '版本库'),
      rightLabel: sides.rightMissing ? '（已删除，无工作副本）' : '工作副本',
      pairs,
    };
  };

  /** Left-right sides of one repository path at `revision` vs its parent
   * (`rN` vs `rN-1`) for the history page. The path travels as a repo-relative
   * URL path (`/trunk/...`); reads go through the repository URL with
   * percent-encoded segments so exotic (Chinese/U+2011) names never reach
   * svn.exe's Windows argv (E155010). */
  api.diffSidesRev = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const revision = Number(p.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      throw badRequest('a positive integer revision is required');
    }
    const { url, wcAbs } = await repoRelTarget(cwd, p.repoRel);
    let offlineSide = null;
    /** Read one side with accurate provenance:
     * - { value }              server or pristine content;
     * - { unavailable: true }  normally a transport failure (this revision is
     *                          not in the local pristine store);
     * - { missing: true }      the repository answered "this path does not
     *                          exist at that revision".
     * The two failure kinds must stay distinct: calling an unavailable side
     * "不存在" (or its absent counterpart) is exactly the misleading output the
     * offline warning is about. */
    const catSide = async (rev) => {
      if (rev < 1) return { missing: true };
      try {
        const got = await catUrl(cwd, url, rev, { offlineOk: true, wcAbs });
        if (got === null) return { unavailable: true };
        if (got.offline === true) offlineSide = rev;
        return { value: got };
      } catch (error) {
        if (isTransportError(error)) return { unavailable: true };
        return { missing: true };
      }
    };
    const leftSide = await catSide(revision);
    const rightSide = await catSide(revision - 1);
    const left = leftSide.value ?? null;
    const right = rightSide.value ?? null;
    try {
      if (left?.binary || right?.binary) {
        return { path: p.repoRel, revision, binary: true, message: '二进制文件，无法左右对比' };
      }
      const pairs = mergeModifiedPairs(alignLines(splitLines(left?.text ?? ''), splitLines(right?.text ?? '')));
      const label = (rev, side) => {
        if (side.unavailable) return `r${rev}（本地不可用）`;
        if (side.missing) return `r${rev}（不存在）`;
        return `r${rev}`;
      };
      let note;
      if (offlineSide !== null) {
        note = `离线本地数据：r${offlineSide} 取自工作副本当前持有的本地内容；另一侧版本不在本地（服务器不可达），本次对比只反映本地已有的那一侧，可能误导。`;
      } else if (leftSide.unavailable || rightSide.unavailable) {
        note = '离线/不可用：需要的版本不在本地（服务器不可达），无法对比。';
      }
      return {
        path: p.repoRel,
        revision,
        binary: false,
        offline: offlineSide !== null,
        offlineSide,
        unavailable: leftSide.unavailable === true || rightSide.unavailable === true,
        note,
        leftMissing: left === null,
        rightMissing: right === null,
        leftLabel: label(revision, leftSide),
        rightLabel: label(revision - 1, rightSide),
        pairs,
        text: pairsToUnified(pairs, p.repoRel, revision, `r${revision - 1}`),
      };
    } finally {
      if (left?.temp) await fs.unlink(left.temp).catch(() => {});
      if (right?.temp) await fs.unlink(right.temp).catch(() => {});
    }
  };

  /** Revert one repository file in the working copy to the revision before
   * `revision` (rN → rN-1). Never commits — the file shows up as a local
   * modification for the user to review and commit:
   * - mode 'undo': reverse-merge r{N}:r{N-1} of that path into the working
   *   copy (`svn merge`, source = its own percent-encoded URL, peg = rN so
   *   it still resolves if the path changed/deleted later). Keeps changes of
   *   later revisions on the file; may conflict (text markers / binary C).
   *   Added-in-rN files: reverse-merge of an add is a silent no-op in svn
   *   1.14 (verified), so the undo = `svn delete` from the WC. Deleted-in-rN
   *   files: merge cannot reverse a deletion (peg@rN does not exist), so the
   *   undo = restore the file's previous-version content + schedule add.
   * - mode 'restore': overwrite the WC file with the file's PREVIOUS VERSION
   *   — the content it had at its last-changed revision before rN (NOT
   *   r{N-1}, which may not have touched the file). `svn cat` bytes + fs
   *   write, binary-safe, later revisions and local edits are discarded.
   *   Files added in rN → `svn delete`; files deleted in rN → write + `svn
   *   add` (scheduled restore). Both modes return `prevRev` (the file's
   *   last-changed revision before rN) for UI notices.
   * - mode 'to-this': overwrite the working-copy file with its content at
   *   rN (THIS version) — the inverse of restore: rN and anything after are
   *   what the file becomes. Deleted-in-rN files → remove from the WC;
   *   added-in-rN files → write rN content (+ schedule add when absent).
   *   Local fast path when the WC's BASE already IS rN (`svn revert`). */
  api.historyRevert = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const revision = Number(p.revision);
    const mode = p.mode;
    if (mode !== 'undo' && mode !== 'restore' && mode !== 'to-this') {
      throw badRequest('mode must be "undo", "restore" or "to-this"');
    }
    if (!Number.isInteger(revision) || revision < 1) {
      throw badRequest('revision must be a positive integer');
    }
    if (mode !== 'to-this' && revision < 2) {
      throw badRequest('revision must be an integer >= 2 (r1 has no previous version)');
    }
    const { url, wcAbs } = await repoRelTarget(cwd, p.repoRel);
    const exists = await fs.access(wcAbs).then(() => true).catch(() => false);
    /** Local (no server) facts about this path, read from wc.db — `svn info`
     * cannot be trusted here because a non-ASCII path is mangled by svn.exe's
     * Windows argv (W155010/E200009). Returns { rev, changedRev, locallyAdded }
     * or null when the node is not in the working copy. */
    const localDbNode = async () => {
      try {
        const info = await wcInfo(cwd, { ttl: 3000 });
        if (!info.workingCopyRoot) return null;
        const rel = path.relative(info.workingCopyRoot, wcAbs).split(path.sep).join('/');
        if (rel === '' || rel.startsWith('..')) return null;
        const DatabaseSync = await loadSqlite();
        if (!DatabaseSync) return null;
        const db = new DatabaseSync(path.join(info.workingCopyRoot, '.svn', 'wc.db'), { readOnly: true });
        try {
          let node = rel;
          let row;
          for (;;) {
            row = db.prepare('SELECT revision, changed_revision FROM NODES WHERE local_relpath = ? AND op_depth = 0').get(node);
            if (row !== undefined) break;
            const parent = node.includes('/') ? node.slice(0, node.lastIndexOf('/')) : '';
            if (parent === '') return null;
            node = parent;
          }
          const added = db.prepare('SELECT 1 AS x FROM NODES WHERE local_relpath = ? AND op_depth > 0').get(node);
          const num = (v) => (v === undefined || v === null ? null : Number(v));
          return { rev: num(row.revision), changedRev: num(row.changed_revision), locallyAdded: added !== undefined };
        } finally { db.close(); }
      } catch { return null; }
    };
    /** True when the repository path exists at `rev` (cheap `svn info`
     * probe). Only a definite "path does not exist at rev" returns false;
     * connectivity or other failures rethrow so the caller can never
     * misclassify them as added/deleted and trigger a file removal.
     *
     * Offline (transport error) the answer degrades to the conservative local
     * one: a node that is still present in the working copy (and not locally
     * scheduled for add) DID exist at `rev` — assuming the opposite is what
     * would silently turn "undo this revision" into "delete the file". */
    const existsAtRev = async (rev) => {
      try {
        await runSvn(['info', '-r', String(rev), `${url}@${rev}`], { cwd, timeout: 60000 });
        return true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!isTransportError(error)
          && /non-existent|E160006|W160006|not found|No such|不存在/i.test(msg)) return false;
        if (isTransportError(error)) {
          const node = await localDbNode();
          if (node === null) return true;              // unknown → do not delete
          if (node.locallyAdded) return false;          // scheduled add in the WC
          return true;
        }
        throw error;
      }
    };
    /** The file's PREVIOUS VERSION: its last-changed revision as of r{N-1}
     * — the content it had right before rN modified it (may be much older
     * than r{N-1}, which is why we resolve it instead of assuming N-1).
     *
     * Offline, wc.db still tells us the revision the working copy holds:
     * - node's last-changed revision <= r{N-1} → that revision IS its
     *   previous version (the only version whose content is available);
     * - node locally scheduled for add → added since, "no previous version";
     * - anything else (changed exactly in rN) is genuinely unknown, so
     *   `prevRev: null` — the caller must not guess, because guessing "added
     *   in rN" would delete the file and guessing r{N-1} would write the wrong
     *   content. */
    const prevInfo = async () => {
      try {
        const xml = await runSvn(['info', '--xml', '-r', String(revision - 1), `${url}@${revision - 1}`], { cwd, timeout: 60000 });
        const rev = tagAttr(xml, 'commit', 'revision');
        return { exists: true, prevRev: rev !== undefined ? Number(rev) : (revision - 1) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!isTransportError(error)
          && /non-existent|E160006|W160006|not found|No such|不存在/i.test(msg)) return { exists: false, prevRev: null };
        if (isTransportError(error)) {
          const node = await localDbNode();
          if (node === null) return { exists: true, prevRev: null, offlineUnknown: true };
          if (node.locallyAdded) return { exists: false, prevRev: null };
          if (node.changedRev !== null && node.changedRev <= revision - 1) {
            return { exists: true, prevRev: node.changedRev, offline: true };
          }
          return { exists: true, prevRev: null, offlineUnknown: true };
        }
        throw error;
      }
    };
    /** Remove the file from the working copy (scheduled delete). Locally
     * modified / locally re-added files (E195006) are deleted with --force
     * — "revert/退回" discards that local content by design; unversioned
     * files are never force-deleted (their error is not E195006). */
    const deleteWcFile = async () => {
      try {
        return await runSvn(['delete', '--non-interactive', '--', wcAbs], { cwd, timeout: 120000 });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/E195006|local modifications/i.test(msg)) {
          return await runSvn(['delete', '--non-interactive', '--force', '--', wcAbs], { cwd, timeout: 120000 });
        }
        throw error;
      }
    };
    /** File was ADDED in rN (no previous version exists): reverting means
     * removing it from the working copy (scheduled delete). */
    const deleteAddedFile = async () => {
      if (!exists) {
        throw badRequest(`工作副本中不存在该文件（可能未更新到 r${revision}），请先更新工作副本`);
      }
      const output = await deleteWcFile();
      return { mode, effect: 'delete', output, prevRev: null };
    };
    /** Write the file's previous-version content (exact bytes at its
     * last-changed revision before rN); schedule an add when the file is
     * absent from the working copy. Byte-exact, binary-safe — content is
     * streamed into a temp file (no maxBuffer limit), compared by SHA-1 and
     * copied into place. When the working copy's BASE already IS the
     * previous version, `svn revert` restores it from the local pristine
     * copy without contacting the repository. */
    /** Content of one repository revision, tolerating an unreachable server:
     * answered from the local pristine store when that revision IS the one the
     * working copy currently holds, otherwise a clean "not available offline"
     * error (so the caller names the missing revision instead of showing a raw
     * transport error). */
    const catForRevert = async (rev) => {
      const got = await catToTemp(cwd, url, rev, { offlineOk: true, wcAbs });
      if (got === null) {
        throw new Error(`离线/服务器不可达：无法取得 r${rev} 的版本库内容（本地只保存工作副本当前持有的那个版本），该回退操作无法在离线状态完成`);
      }
      return got;
    };
    const restoreContent = async (prevRev) => {
      const baseRev = await wcBaseRev();
      if (prevRev === null || prevRev === undefined) {
        throw new Error('无法解析该文件的“修改前版本”修订号（服务器不可达且本地元数据不足），该回退操作无法完成');
      }
      if (baseRev !== null && baseRev === prevRev) {
        const output = await runSvn(['revert', '--non-interactive', '--', wcAbs], { cwd, timeout: 120000 });
        return { mode, effect: 'revert', output, prevRev };
      }
      const { temp } = await catForRevert(prevRev);
      try {
        if (exists) {
          const same = await filesEqual(wcAbs, temp);
          if (same) return { mode, effect: 'unchanged', prevRev };
          await fs.copyFile(temp, wcAbs);
          return { mode, effect: 'content', prevRev };
        }
        await fs.copyFile(temp, wcAbs);
        const output = await runSvn(['add', '--non-interactive', '--', wcAbs], { cwd, timeout: 120000 });
        return { mode, effect: 'restore-add', output, prevRev };
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    };
    /** The working copy's BASE last-changed revision of this file (local svn
     * info — no repository contact); null when it cannot be read (e.g. the
     * file is missing or its name is non-ASCII and mangled by svn.exe). */
    const wcBaseRev = async () => {
      try {
        const xml = await runSvn(['info', '--xml', '--', wcAbs], { cwd, timeout: 30000 });
        const rev = tagAttr(xml, 'commit', 'revision');
        return rev !== undefined ? Number(rev) : null;
      } catch { return null; }
    };
    /** The working copy's LAST-CHANGED revision for this file — the revision
     * whose content the local pristine actually holds, so a pristine read can
     * answer exactly that revision without contacting the repository. Falls
     * back to the node's checked-out revision from wc.db when svn.exe cannot
     * take the (possibly non-ASCII) path. */
    const wcLastChangedRev = async () => {
      try {
        const xml = await runSvn(['info', '--xml', '--', wcAbs], { cwd, timeout: 30000 });
        const rev = tagAttr(xml, 'commit', 'revision');
        if (rev !== undefined) return Number(rev);
      } catch { /* exotic path name or missing file */ }
      const node = await localDbNode();
      return node === null || node.locallyAdded ? null : node.changedRev;
    };
    if (mode === 'undo') {
      const atN = await existsAtRev(revision);
      const prev = await prevInfo();
      if (!atN) return restoreContent(prev.prevRev); // deleted in rN → restore previous version
      if (!prev.exists) return deleteAddedFile(); // added in rN
      const argv = ['merge', '--non-interactive', '-r', `${revision}:${revision - 1}`,
        `${url}@${revision}`, '--', wcAbs];
      const output = await runSvn(argv, { cwd, timeout: 300000 });
      return { mode, effect: 'merge', output, prevRev: prev.prevRev };
    }
    // mode 'to-this': make the working-copy file match its rN state
    // (content at THIS revision), overwriting the current file.
    if (mode === 'to-this') {
      const atN = await existsAtRev(revision);
      if (!atN) {
        // Deleted in rN: this version's state = file absent → remove from WC.
        if (!exists) return { mode, effect: 'unchanged', prevRev: revision };
        const output = await deleteWcFile();
        return { mode, effect: 'delete', output, prevRev: null };
      }
      const baseRev = await wcLastChangedRev();
      if (baseRev !== null && baseRev === revision) {
        const output = await runSvn(['revert', '--non-interactive', '--', wcAbs], { cwd, timeout: 120000 });
        return { mode, effect: 'revert', output, prevRev: revision };
      }
      const { temp } = await catForRevert(revision);
      try {
        if (exists) {
          const same = await filesEqual(wcAbs, temp);
          if (same) return { mode, effect: 'unchanged', prevRev: revision };
          await fs.copyFile(temp, wcAbs);
          return { mode, effect: 'content', prevRev: revision };
        }
        await fs.copyFile(temp, wcAbs);
        const output = await runSvn(['add', '--non-interactive', '--', wcAbs], { cwd, timeout: 120000 });
        return { mode, effect: 'restore-add', output, prevRev: revision };
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    }
    // mode 'restore'
    const prev = await prevInfo();
    if (!prev.exists) return deleteAddedFile(); // added in rN
    return restoreContent(prev.prevRev);
  };

  /** For the history detail pane: each path's PREVIOUS VERSION — the
   * revision at which the file was last changed BEFORE `revision` (the
   * content the file had right before rN modified it; may be much older
   * than r{N-1}). null = the path does not exist before rN (added in rN).
   * Used to label the revert buttons with the correct revision. */
  api.historyPrevRevs = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const revision = Number(p.revision);
    if (!Number.isInteger(revision) || revision < 2) {
      throw badRequest('revision must be an integer >= 2');
    }
    const paths = Array.isArray(p.paths) ? p.paths : [];
    const entries = [];
    for (const repoRel of paths) {
      const { url } = await repoRelTarget(cwd, repoRel);
      let prevRev = null;
      try {
        const xml = await runSvn(['info', '--xml', '-r', String(revision - 1), `${url}@${revision - 1}`], { cwd, timeout: 60000 });
        const rev = tagAttr(xml, 'commit', 'revision');
        if (rev !== undefined) prevRev = Number(rev);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/non-existent|E160006|E200009|W170000|not found|No such|不存在/i.test(msg)) {
          prevRev = null;
        } else {
          throw error;
        }
      }
      entries.push({ path: repoRel, prevRev });
    }
    return { entries };
  };

  /** Apply one diff block's text choice to the working copy file. */
  api.diffChoose = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd);
    if (!target) throw Object.assign(new Error('path is required'), { code: 'bad-request', status: 400 });
    const block = p.block;
    if (!block || !Number.isInteger(block.start) || !Number.isInteger(block.end)) {
      throw Object.assign(new Error('block {start, end} is required'), { code: 'bad-request', status: 400 });
    }
    const mode = p.mode;
    if (!['left', 'right', 'both-left-first', 'both-right-first'].includes(mode)) {
      throw Object.assign(new Error('mode must be left/right/both-left-first/both-right-first'), { code: 'bad-request', status: 400 });
    }
    const sides = await readSides(cwd, target);
    if (sides.binary) throw Object.assign(new Error('二进制文件，无法编辑'), { code: 'bad-request', status: 400 });
    const pairs = mergeModifiedPairs(alignLines(splitLines(sides.left ?? ''), splitLines(sides.right ?? '')));
    if (block.start > block.end || block.end >= pairs.length) {
      throw Object.assign(new Error('block out of range'), { code: 'bad-request', status: 400 });
    }
    const raw = await fs.readFile(target);
    const nl = raw.includes(Buffer.from([0x0d, 0x0a])) ? '\r\n' : '\n';
    const hadTrailing = /(?:\r?\n)$/.test(sides.right ?? '');
    const out = [];
    for (let i = 0; i < pairs.length; i++) {
      const L = pairs[i].left;
      const R = pairs[i].right;
      if (i >= block.start && i <= block.end) {
        if (mode === 'left') { if (L) out.push(L.text); }
        else if (mode === 'right') { if (R) out.push(R.text); }
        else if (mode === 'both-left-first') { if (L) out.push(L.text); if (R) out.push(R.text); }
        else { if (R) out.push(R.text); if (L) out.push(L.text); }
      } else {
        out.push(R ? R.text : '');
      }
    }
    await fs.writeFile(target, out.join(nl) + (hadTrailing ? nl : ''), 'utf8');
    return { path: target, mode, block };
  };

  /** Commit history.
   *
   * mode 'remote' (default): `svn log` against the repository — the server is
   * required (SVN keeps commit messages server-side only). Every successful
   * page is merged into the working copy's log cache so a later offline run
   * can still show it.
   *
   * mode 'local' (offline / read-only): never contacts the server — serves
   * the cache (`source: 'cache'`, real messages/authors/dates/changed paths)
   * plus locally reconstructed revisions from `.svn/wc.db`
   * (`source: 'local'`, `messageKnown: false`; SVN does not store commit
   * messages in the working copy, and deleted paths cannot be recovered).
   * Only the target working copy's own subtree is reconstructed, so entries
   * never claim changes from other parts of a multi-project repository.
   *
   * A transport failure in 'remote' mode falls back to 'local' instead of
   * failing, and reports `offline: true` so the panel can say so. */
  api.log = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd) ?? cwd;
    const limit = Math.max(1, Math.min(p.limit ?? 20, 200));
    const olderThan = p.olderThan !== undefined && p.olderThan !== null && p.olderThan !== ''
      ? Number(p.olderThan)
      : undefined;
    const localOnly = p.mode === 'local' || p.local === true;
    const localAnswer = async (extra) => {
      const local = await localHistoryEntries(cwd, { limit, olderThan });
      const reason = extra && extra.reason ? extra.reason : 'unreachable';
      return Object.assign({
        entries: local.entries,
        mode: 'local',
        source: local.entries.some((e) => e.source === 'cache') ? 'cache+local' : 'local',
        offline: true,
        reason,
        localRevision: local.localRevision,
        newestCached: local.newestCached,
        cachedAt: local.cachedAt,
        hasSnapshot: local.hasSnapshot,
        note: reason === 'repository-missing'
          ? '服务器可达，但该 URL 上已没有版本库（E210005：可能被改名/删除/停用，或账号下版本库被移除）——历史列表来自本地日志缓存与工作副本元数据，是不完整的本地数据，可能过时甚至误导。'
          : '离线数据：来自本地日志缓存与工作副本修订元数据，可能不完整、可能过时。',
      }, extra ?? {});
    };
    if (localOnly) return localAnswer({ readOnly: p.readOnly === true });

    // Query from HEAD: without `-r HEAD:...` svn log stops at the working
    // copy's BASE revision, hiding newer repository commits from the history
    // list. `HEAD:1` (range) + `-l N` yields the N newest revisions.
    //
    // `olderThan` continues the list below an already-shown revision (the
    // history page's "load more"): the caller has displayed revisions down
    // to r<olderThan>, so query the range strictly below it and return up
    // to `limit` older entries. r1 has nothing older, so answer empty.
    let range = 'HEAD:1';
    if (olderThan !== undefined) {
      if (!Number.isInteger(olderThan) || olderThan <= 1) return { entries: [], mode: 'remote' };
      range = `${olderThan - 1}:1`;
    }
    const argv = ['log', '--xml', '-r', range, '-l', String(limit)];
    if (p.verbose) argv.push('-v');
    argv.push('--', target);
    let xml;
    let info;
    try {
      xml = await runSvn(argv, { cwd, timeout: 60000 });
    } catch (error) {
      if (!isTransportError(error)) throw error;
      try { info = await wcInfo(cwd); } catch { /* keep the mark keyless */ }
      markConn(info, false, error);
      return localAnswer({
        message: error instanceof Error ? error.message : String(error),
        reason: isRepositoryMissingError(error) ? 'repository-missing' : 'unreachable',
      });
    }
    try { info = await wcInfo(cwd); } catch { /* keep the mark keyless */ }
    markConn(info, true);
    const entries = parseLog(xml).map((e) => Object.assign(e, { source: 'remote', messageKnown: true }));
    // Best-effort cache write: the next offline run replays these entries.
    // `svn log` on a path returns repository-wide history for the revisions
    // it lists, so caching the whole page is correct for any later path query.
    if (entries.length > 0 && !(olderThan !== undefined && olderThan <= 1)) {
      try {
        const state = await readHistoryCache(cwd);
        for (const e of entries) {
          if (Number.isInteger(e.revision) && e.revision > 0) state.entries[e.revision] = e;
        }
        state.repoUrl = info?.url;
        state.fetchedAt = Date.now();
        await writeHistoryCache(cwd, state);
      } catch { /* caching is best-effort */ }
    }
    return { entries, mode: 'remote', source: 'remote', offline: false };
  };

  /** Connection state of the working copy's repository, for the panel's
   * 在线/离线/只读 mode switch. 'offline' is reported when the last
   * server-dependent operation failed with a transport error; 'read-only' is
   * the caller's own forced mode (online, but writes disabled). Asking for
   * `probe` re-checks by contacting the repository (a fresh `svn log -l 1`
   * is the cheapest reliable round-trip) and flips the state back to online
   * when it succeeds — offline is never a permanent state. */
  api.connection = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const readOnly = p.readOnly === true;
    let info = null;
    try { info = await wcInfo(cwd, { ttl: 3000 }); } catch { /* not a working copy */ }
    let reachable = connFor(info).reachable;
    let error = connFor(info).error;
    if (p.probe === true) {
      try {
        await runSvn(['log', '--xml', '-l', '1', '-r', 'HEAD', '--', cwd], { cwd, timeout: 30000 });
        markConn(info, true);
        reachable = true;
        error = null;
      } catch (probeError) {
        if (!isTransportError(probeError)) throw probeError;
        markConn(info, false, probeError);
        reachable = false;
        error = probeError instanceof Error ? probeError.message : String(probeError);
      }
    }
    const state = connFor(info);
    const mode = readOnly ? 'read-only' : (state.reachable === false ? 'offline' : 'online');
    const reason = state.reachable === false
      ? (isRepositoryMissingError(state.error ?? error ?? '') ? 'repository-missing' : 'unreachable')
      : null;
    return {
      mode,
      readOnly,
      reachable: state.reachable,
      reason,
      checkedAt: state.checkedAt,
      errorSince: state.errorSince,
      error: error ?? state.error ?? null,
      repoUrl: info?.url ?? null,
      localRevision: info?.revision !== undefined && info.revision !== '' ? Number(info.revision) : null,
      note: mode === 'offline'
        ? (reason === 'repository-missing'
          ? '服务器可达，但该 URL 上已没有版本库（可能被改名/删除/停用）：正在显示本地缓存与工作副本元数据，可点「重试」复查。'
          : '服务器不可达：正在显示本地缓存与工作副本元数据，可随时「重试」恢复在线。')
        : mode === 'read-only'
          ? '只读模式：写操作已禁用（查看不受影响）。'
          : null,
    };
  };

  api.add = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const targets = (p.paths ?? []).map((x) => resolveTargetAbs(x, cwd));
    if (targets.length === 0) throw Object.assign(new Error('paths are required'), { code: 'bad-request', status: 400 });
    const argv = ['add', '--non-interactive'];
    if (p.force) argv.push('--force');
    argv.push('--', ...targets);
    const output = await runSvn(argv, { cwd, timeout: 120000 });
    return { output };
  };

  api.revert = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const targets = (p.paths ?? []).map((x) => resolveTargetAbs(x, cwd));
    if (targets.length === 0) throw Object.assign(new Error('paths are required'), { code: 'bad-request', status: 400 });
    const argv = ['revert', '--non-interactive'];
    if (p.recursive) argv.push('-R');
    argv.push('--', ...targets);
    const output = await runSvn(argv, { cwd, timeout: 120000 });
    return { output };
  };

  api.update = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd) ?? cwd;
    const argv = ['update', '--non-interactive'];
    if (p.revision) argv.push('-r', p.revision);
    argv.push('--', target);
    const output = await runSvn(argv, { cwd, timeout: 300000 });
    const m = output.match(/revision\s+(\d+)/i) ?? output.match(/版本\s*(\d+)/);
    return { revision: m ? Number(m[1]) : undefined, output };
  };

  /** Streaming update jobs: svn update runs in the background, the client
   * polls `update-poll` for live progress (processed item count, recent
   * output lines, elapsed time). Job rows are dropped ~10 min after finish. */
  const updateJobs = new Map();

  api.updateStart = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd) ?? cwd;
    const argv = ['update', '--non-interactive'];
    if (p.revision) argv.push('-r', p.revision);
    argv.push('--', target);
    const jobId = randomUUID();
    const job = { running: true, processed: 0, lines: [], revision: undefined, error: undefined, startedAt: Date.now() };
    updateJobs.set(jobId, job);
    const child = spawn(SVN, argv, { cwd, windowsHide: true });
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    const feed = (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        line = line.trim();
        if (line !== '') {
          job.lines.push(line);
          if (job.lines.length > 100) job.lines.shift();
          // svn update prints one line per item: "A    path", "U    path", ...
          if (/^[A-Z]\s+\S/.test(line)) job.processed++;
        }
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    // Hard safety net: kill after 15 minutes (updates can pull big packages).
    const killer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 15 * 60 * 1000);
    child.on('error', (e) => {
      job.running = false;
      job.error = String(e);
      clearTimeout(killer);
      setTimeout(() => updateJobs.delete(jobId), 10 * 60 * 1000).unref?.();
    });
    child.on('close', (code) => {
      job.running = false;
      clearTimeout(killer);
      const all = job.lines.join('\n');
      if (code === 0) {
        const m = all.match(/Updated to revision\s+(\d+)/i) ?? all.match(/版本\s*(\d+)/);
        if (m) job.revision = Number(m[1]);
      } else if (job.error === undefined) {
        job.error = job.lines.slice(-4).join('\n') || `svn update 异常退出（code ${code}）`;
      }
      setTimeout(() => updateJobs.delete(jobId), 10 * 60 * 1000).unref?.();
    });
    return { jobId };
  };

  api.updatePoll = async (p) => {
    const job = updateJobs.get(p.jobId);
    if (job === undefined) {
      return { running: false, done: true, processed: 0, lines: [], error: '更新任务已过期或不存在（服务器可能已重启）' };
    }
    return {
      running: job.running,
      done: !job.running,
      processed: job.processed,
      lines: job.lines.slice(-8),
      revision: job.revision,
      error: job.error,
      elapsedMs: Date.now() - job.startedAt,
    };
  };

  api.commit = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    if (!p.message || String(p.message).trim() === '') {
      throw Object.assign(new Error('commit message is required'), { code: 'bad-request', status: 400 });
    }
    const logFile = path.join(os.tmpdir(), `dsh-svn-commit-${randomUUID()}.txt`);
    const targets = (p.paths ?? []).map((x) => resolveTargetAbs(x, cwd));
    let prepared;
    if (targets.length > 0) {
      prepared = await prepareForCommit(cwd, targets);
    } else {
      // commit-all: also auto-prepare every unversioned (?) and missing (!)
      // entry, because plain `svn commit` silently skips both. When the UI
      // hides unversioned files (includeUnversioned === false) they are
      // excluded from the commit scope too — only missing (!) versioned
      // files get auto-deleted; never-added (?) files stay untouched.
      const includeUnversioned = p.includeUnversioned !== false;
      let entries = [];
      try {
        const xml = await runSvn(['status', '--xml', '--', cwd], { cwd, timeout: 60000 });
        entries = parseStatus(xml);
      } catch { /* status unavailable — commit as-is */ }
      const pending = entries
        .filter((e) => (e.status === '?' && includeUnversioned) || e.status === '!')
        .map((e) => e.path);
      prepared = pending.length > 0 ? await prepareForCommit(cwd, pending) : { added: [], deleted: [], skipped: [] };
    }
    try {
      await fs.writeFile(logFile, String(p.message), { encoding: 'utf8' });
      const argv = ['commit', '--non-interactive', '--encoding', 'utf-8', '-F', logFile];
      if (targets.length > 0) argv.push('--', ...targets);
      const output = await runSvn(argv, { cwd, timeout: 300000 });
      const m = output.match(/Committed revision\s+(\d+)/i)
        ?? output.match(/提交\s*(?:的)?\s*版本\s*[：:]\s*(\d+)/)
        ?? output.match(/revision\s+(\d+)/i);
      return {
        revision: m ? Number(m[1]) : undefined,
        output,
        added: prepared.added.length > 0 ? prepared.added : undefined,
        deleted: prepared.deleted.length > 0 ? prepared.deleted : undefined,
        // Paths the 提交 settings told us to leave alone (unversioned with
        // 自动添加 off, missing with 自动删除 off): svn skipped them silently,
        // so the panel says so instead of pretending the commit covered them.
        skipped: prepared.skipped !== undefined && prepared.skipped.length > 0 ? prepared.skipped : undefined,
      };
    } finally {
      await fs.rm(logFile, { force: true }).catch(() => {});
    }
  };

  api.generateMessage = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    // Scope mirrors the commit scope sent by the client: an explicit path
    // list (files checked in the 提交 list — everything else is NOT
    // analyzed) or "commit all" with unversioned (?) files optionally
    // hidden/excluded (includeUnversioned === false).
    const wantPaths = Array.isArray(p.paths) && p.paths.length > 0;
    const includeUnversioned = p.includeUnversioned !== false;

    // 1. collect working-copy changes, narrowed to the requested scope
    const xml = await runSvn(['status', '--xml', '--', cwd], { cwd, timeout: 60000 });
    const all = parseStatus(xml);
    let entries;
    if (wantPaths) {
      const wanted = new Set(p.paths.map((x) => String(x).toLowerCase()));
      entries = all.filter((e) => wanted.has(String(e.path).toLowerCase()));
    } else if (!includeUnversioned) {
      entries = all.filter((e) => e.status !== '?');
    } else {
      entries = all;
    }
    if (entries.length === 0) {
      const note = all.length === 0
        ? '工作副本没有变更，无需提交'
        : wantPaths
          ? '勾选范围内没有发现变更文件，未生成提交日志'
          : '没有已版本化的变更可分析（未版本化文件已隐藏，不会提交）';
      return { message: '', model: undefined, note };
    }

    // 2. scoped diff (bounded). A whole-wc scope keeps the single `svn diff`
    // call; a path selection diffs each versioned entry individually through
    // diffWithFallback (falls back to BASE/pristine reads when svn.exe's
    // Windows argv mangles Chinese/exotic paths, E155010).
    const MAX_DIFF_CHARS = 40000;
    let diff = '';
    let truncated = false;
    if (wantPaths) {
      const targets = entries.filter((e) => e.status !== '?' && e.status !== '!');
      const LIMIT = 120;
      for (let i = 0; i < Math.min(targets.length, LIMIT) && !truncated; i++) {
        let part = '';
        try { part = await diffWithFallback(cwd, targets[i].path); } catch { /* skip un-diffable entry */ }
        if (!part) continue;
        diff += (diff ? '\n' : '') + part;
        if (diff.length > MAX_DIFF_CHARS) {
          diff = diff.slice(0, MAX_DIFF_CHARS) + '\n...(diff 过长，已截断)';
          truncated = true;
        }
      }
      if (!truncated && targets.length > LIMIT) {
        diff += `\n...(diff 过多，已截断，仅分析前 ${LIMIT} 个文件)`;
      }
    } else {
      try {
        diff = await runSvn(['diff', '--', cwd], { cwd, timeout: 120000 });
      } catch { /* binary-only or empty changes: diff stays empty */ }
      if (diff.length > MAX_DIFF_CHARS) {
        diff = diff.slice(0, MAX_DIFF_CHARS) + '\n...(diff 过长，已截断)';
        truncated = true;
      }
    }

    // 3. resolve the current model route: the session agent's own selection
    //    first, then the deployment default model.
    let provider;
    let model;
    let reasoningEffort;
    try {
      const agent = ctx.agents?.get(p.sessionId);
      provider = agent?.options?.provider;
      model = agent?.options?.model;
    } catch { /* agent registry unavailable */ }
    if (!provider || !model) {
      try {
        const def = ctx.get?.('agentDefaultModel')?.currentSelection?.();
        if (def) {
          provider = provider ?? def.provider;
          model = model ?? def.model;
          reasoningEffort = def.reasoningEffort;
        }
      } catch { /* no default model service */ }
    }
    if (!provider || !model) {
      throw Object.assign(new Error('无法解析当前模型（会话未配置模型路由，且没有部署默认模型）'), { code: 'no-model', status: 400 });
    }

    // 4. build the prompt
    const STATUS_LABEL = {
      M: '已修改', A: '已添加', D: '已删除', R: '已替换', C: '冲突', '!': '缺失', '?': '未版本化', '~': '类型变更',
    };
    const fileLines = entries.map((e) => `  ${e.status} ${STATUS_LABEL[e.status] ?? e.status}  ${e.path}`).join('\n');
    const system = '你是一个 SVN 提交日志助手。根据给定的工作副本变更信息，生成一条简洁的提交日志（commit message）。' +
      '规则：1) 必须用中文书写；2) 第一行用一句话概括本次改动的主题（不超过 40 字，不要以"本次提交"或"更新"开头）；' +
      '3) 如果改动包含多个方面，第一行之后用 "- " 列表逐条补充要点；4) 只输出提交日志正文本身，不要任何解释、前后缀、引号或代码块标记。';
    const userText = '以下是 SVN 工作副本的变更（文件列表 + unified diff 摘要）：\n\n' +
      `【变更文件】\n${fileLines}\n\n` +
      `【diff 摘要】\n${diff || '(无文本差异)'}\n\n` +
      '请生成提交日志：';
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'plugin', plugin: 'dsh-svn-tools' },
    });

    // 5. stream the model output
    let text = '';
    let failed = false;
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      system,
      messages: [userMsg],
      maxTokens: 500,
      temperature: 0.3,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'finish' && chunk.reason === 'error') failed = true;
    }
    if (failed && text.trim() === '') {
      throw Object.assign(new Error('模型调用失败，未生成提交日志'), { code: 'llm-error', status: 502 });
    }
    return {
      message: text.trim(),
      model: `${provider}/${model}`,
      truncated: truncated || undefined,
      note: undefined,
    };
  };

  api.cleanup = (p) => svnCleanup(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.resolve = (p) => svnResolve(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.delete = (p) => svnDelete(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.mkdir = (p) => svnMkdir(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.propget = (p) => svnPropget(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.propset = (p) => svnPropset(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.proplist = (p) => svnProplist(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.propdel = (p) => svnPropdel(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.blame = (p) => svnBlame(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.list = (p) => svnList(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.cat = (p) => svnCat(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.checkout = (p) => svnCheckout(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.switch = (p) => svnSwitch(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.copy = (p) => svnCopy(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.move = (p) => svnMove(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.merge = (p) => svnMerge(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.mergeinfo = (p) => svnMergeinfo(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.lock = (p) => svnLock(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.unlock = (p) => svnUnlock(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.changelist = (p) => svnChangelist(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.import = (p) => svnImport(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.export = (p) => svnExport(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.relocate = (p) => svnRelocate(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.patch = (p) => svnPatch(sessionCwdOf(ctx, p.sessionId, p.cwd), p);
  api.upgrade = (p) => svnUpgrade(sessionCwdOf(ctx, p.sessionId, p.cwd), p);

  return api;
}

// --------------------------------------------------------------- tools

/** Render a structured result to plain text. */
function renderResult(value) {
  if (value === undefined || value === null) return '(no output)';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => renderResult(v)).join('\n');
  const lines = [];
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      if (typeof v[0] === 'object' && v[0] !== null) {
        lines.push(`${key}:`);
        for (const item of v) lines.push(`  ${renderResult(item).replace(/\n/g, '\n  ')}`);
      } else {
        lines.push(`${key}: ${v.join(', ')}`);
      }
    } else if (typeof v === 'object') {
      lines.push(`${key}: ${renderResult(v).replace(/\n/g, '\n  ')}`);
    } else {
      lines.push(`${key}: ${String(v)}`);
    }
  }
  return lines.join('\n');
}

function svnTool({ name: toolName, description, params, timeoutMs, readOnly, execute }) {
  return defineTool({
    name: toolName,
    description,
    parameters: params,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    timeoutMs,
    isConcurrencySafe: readOnly ? () => true : undefined,
    async execute(args, exec) {
      try {
        return await execute(args, exec);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    },
  });
}

function tool(name, description, params, opts = {}) {
  return svnTool({
    name,
    description,
    params,
    timeoutMs: opts.timeoutMs ?? 60000,
    readOnly: opts.readOnly ?? false,
    execute: opts.execute,
  });
}

/** Resolve a raw path for a tool call against the session workspace cwd. */
function resolveToolTarget(raw, exec) {
  const cwd = exec.agent?.session?.header?.cwd;
  return resolveTargetAbs(raw, cwd);
}

function toolCwd(exec) {
  return exec.agent?.session?.header?.cwd;
}

export function apply(ctx, config) {
  // -------------------------------------------------------------- settings
  // Register this plugin's namespace in the DSH user-settings document. The
  // composition entry is the `base` layer, the user layer resolves above it,
  // and schema defaults fill the rest — which is what makes the namespace
  // editable from Settings → Plugins → Plugin configuration and durable in
  // `$DSH_HOME/settings.yaml`. Composed without a settings provider (a TUI
  // profile, or a deployment that mounts no `dsh-settings-file`), the plugin
  // simply keeps the documented defaults: `ctx.inject` waits for the service
  // instead of making it a hard dependency, and the dynamic import keeps
  // schemastery optional so a missing package cannot take the 33 tools down.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsService = settingsCtx.settings;
    import('@deepseek-ai/schemastery').then((module) => {
      const z = module.default ?? module;
      const schema = z.object({
        sidebarCarrier: z.union(['auto', 'native', 'better-sidebar', 'off']).default(SETTINGS_DEFAULTS.sidebarCarrier),
        svnPath: z.string().default(SETTINGS_DEFAULTS.svnPath),
        commandTimeoutScale: z.number().min(0.2).max(20).step(0.1).default(SETTINGS_DEFAULTS.commandTimeoutScale),
        historyPageSize: z.number().min(5).max(200).step(1).default(SETTINGS_DEFAULTS.historyPageSize),
        historyCacheEnabled: z.boolean().default(SETTINGS_DEFAULTS.historyCacheEnabled),
        historyCacheMaxEntries: z.number().min(100).max(200000).step(1).default(SETTINGS_DEFAULTS.historyCacheMaxEntries),
        autoAddUnversioned: z.boolean().default(SETTINGS_DEFAULTS.autoAddUnversioned),
        autoDeleteMissing: z.boolean().default(SETTINGS_DEFAULTS.autoDeleteMissing),
        showUnversionedDefault: z.boolean().default(SETTINGS_DEFAULTS.showUnversionedDefault),
        defaultView: z.union(['commit', 'history', 'locks']).default(SETTINGS_DEFAULTS.defaultView),
      });
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, schema, config ?? {}, {
        setSource: (source) => { settingsSource = source; },
        onChange: () => {},
      });
    }).catch((error) => {
      console.warn(`[dsh-svn-tools] settings namespace "${SETTINGS_NAMESPACE}" not registered (schemastery unavailable): ${error?.message ?? error}`);
    });
  });

  // ------------------------------------------------------------ agent tools
  ctx.tools.register(tool('svn_status', 'Show the working copy status of the SVN repository. Lists every changed, added, deleted, conflicted, unversioned, or ignored path under the target (default: the session workspace). Returns structured entries with status codes (M modified, A added, D deleted, C conflicted, ! missing, ? unversioned, ~ replaced).', {
    path: { type: 'string', description: 'Target path (relative to the session workspace or absolute). Defaults to the workspace root.' },
  }, {
    readOnly: true,
    execute: async (args, exec) => {
      const cwd = toolCwd(exec);
      const target = resolveToolTarget(args.path, exec) ?? cwd ?? '.';
      const xml = await runSvn(['status', '--xml', '--', target], { cwd: cwd ?? target, timeout: 60000 });
      const entries = parseStatus(xml);
      const summary = {};
      for (const e of entries) summary[e.status] = (summary[e.status] ?? 0) + 1;
      return { count: entries.length, summary, entries };
    },
  }));

  ctx.tools.register(tool('svn_info', 'Show repository and working-copy information for the target path: repository URL, root, current revision, last-changed revision/author/date, and the working-copy root.', {
    path: { type: 'string', description: 'Target path (relative to the session workspace or absolute). Defaults to the workspace root.' },
  }, {
    readOnly: true,
    execute: async (args, exec) => {
      const cwd = toolCwd(exec);
      const target = resolveToolTarget(args.path, exec) ?? cwd ?? '.';
      const xml = await runSvn(['info', '--xml', '--', target], { cwd: cwd ?? target, timeout: 30000 });
      return parseInfo(xml, target);
    },
  }));

  ctx.tools.register(tool('svn_diff', 'Show the local modifications of the working copy as a unified diff (or the diff between two revisions with `revision`, e.g. "123:456" or "HEAD").', {
    path: { type: 'string', description: 'Target path (relative to the session workspace or absolute). Defaults to the workspace root.' },
    revision: { type: 'string', description: 'Optional revision range like "123:456", or a single revision like "123" or "HEAD".' },
  }, {
    readOnly: true,
    timeoutMs: 120000,
    execute: async (args, exec) => {
      const cwd = toolCwd(exec);
      const target = resolveToolTarget(args.path, exec) ?? cwd ?? '.';
      const diff = await diffWithFallback(cwd ?? target, target, args.revision);
      return { diff };
    },
  }));

  ctx.tools.register(tool('svn_log', 'Show the commit history of the target path, newest first. Each entry includes revision, author, date, message, and changed paths (when verbose).', {
    path: { type: 'string', description: 'Target path (relative to the session workspace or absolute). Defaults to the workspace root.' },
    limit: { type: 'integer', description: 'Max log entries to return (default 10).' },
    verbose: { type: 'boolean', description: 'Also list the changed paths of each revision (default false).' },
  }, {
    readOnly: true,
    execute: async (args, exec) => {
      const cwd = toolCwd(exec);
      const target = resolveToolTarget(args.path, exec) ?? cwd ?? '.';
      const limit = Math.max(1, Math.min(args.limit ?? 10, 200));
      const argv = ['log', '--xml', '-l', String(limit)];
      if (args.verbose) argv.push('-v');
      argv.push('--', target);
      const xml = await runSvn(argv, { cwd: cwd ?? target, timeout: 60000 });
      return { entries: parseLog(xml) };
    },
  }));

  ctx.tools.register(tool('svn_add', 'Schedule files or directories for addition to version control. Requires explicit paths.', {
    paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths to add (relative to the session workspace or absolute).' },
    force: { type: 'boolean', description: 'Force adding files that would otherwise be ignored (default false).' },
  }, {
    execute: async (args, exec) => {
      const cwd = toolCwd(exec) ?? '.';
      const targets = (args.paths ?? []).map((p) => resolveToolTarget(p, exec));
      const argv = ['add', '--non-interactive'];
      if (args.force) argv.push('--force');
      argv.push('--', ...targets);
      const output = await runSvn(argv, { cwd, timeout: 120000 });
      return { output };
    },
  }));

  ctx.tools.register(tool('svn_revert', 'Revert local changes of the given paths back to the pristine working-copy state. Destructive: uncommitted changes on those paths are lost.', {
    paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths to revert (relative to the session workspace or absolute).' },
    recursive: { type: 'boolean', description: 'Revert directories recursively (default false).' },
  }, {
    execute: async (args, exec) => {
      const cwd = toolCwd(exec) ?? '.';
      const targets = (args.paths ?? []).map((p) => resolveToolTarget(p, exec));
      const argv = ['revert', '--non-interactive'];
      if (args.recursive) argv.push('-R');
      argv.push('--', ...targets);
      const output = await runSvn(argv, { cwd, timeout: 120000 });
      return { output };
    },
  }));

  ctx.tools.register(tool('svn_update', 'Update the working copy to the latest revision (or the given revision).', {
    path: { type: 'string', description: 'Target path (relative to the session workspace or absolute). Defaults to the workspace root.' },
    revision: { type: 'string', description: 'Optional revision to update to (e.g. "123" or "HEAD").' },
  }, {
    timeoutMs: 300000,
    execute: async (args, exec) => {
      const cwd = toolCwd(exec);
      const target = resolveToolTarget(args.path, exec) ?? cwd ?? '.';
      const argv = ['update', '--non-interactive'];
      if (args.revision) argv.push('-r', args.revision);
      argv.push('--', target);
      const output = await runSvn(argv, { cwd: cwd ?? target, timeout: 300000 });
      const m = output.match(/revision\s+(\d+)/i) ?? output.match(/版本\s*(\d+)/);
      return { revision: m ? Number(m[1]) : undefined, output };
    },
  }));

  ctx.tools.register(tool('svn_commit', 'Commit local changes to the SVN repository. The log `message` is written to a UTF-8 temp file and submitted with `svn commit --encoding utf-8 -F <file>`, so Chinese log messages are safe. Returns the new revision. Paths default to the whole working copy.', {
    message: { type: 'string', required: true, description: 'Commit log message. Project rule: write it in Chinese.' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Paths to commit (relative to the session workspace or absolute). Defaults to all changes in the working copy.' },
  }, {
    timeoutMs: 300000,
    execute: async (args, exec) => {
      const cwd = toolCwd(exec) ?? '.';
      const logFile = path.join(os.tmpdir(), `dsh-svn-commit-${randomUUID()}.txt`);
      const targets = (args.paths ?? []).map((p) => resolveToolTarget(p, exec));
      try {
        await fs.writeFile(logFile, args.message, { encoding: 'utf8' });
        const argv = ['commit', '--non-interactive', '--encoding', 'utf-8', '-F', logFile];
        if (targets.length > 0) argv.push('--', ...targets);
        const output = await runSvn(argv, { cwd, timeout: 300000 });
        const m = output.match(/Committed revision\s+(\d+)/i)
          ?? output.match(/提交\s*(?:的)?\s*版本\s*[：:]\s*(\d+)/)
          ?? output.match(/revision\s+(\d+)/i);
        return { revision: m ? Number(m[1]) : undefined, output };
      } finally {
        await fs.rm(logFile, { force: true }).catch(() => {});
      }
    },
  }));

  // ------------------------------------------------- extended subcommands
  const EXTENDED_TOOLS = [
    {
      name: 'svn_cleanup', readOnly: false, timeoutMs: 300000,
      description: 'Clean up interrupted or aborted SVN operations left in the working copy (broken locks, unfinished operations). Run this when svn reports "run svn cleanup".',
      params: { paths: { type: 'array', items: { type: 'string' }, description: 'Paths to clean (default: the whole working copy).' } },
    },
    {
      name: 'svn_resolve', readOnly: false,
      description: 'Resolve a conflicted file in the working copy by choosing one side of the conflict: working (keep my local edits), base (original), mine-full (my version), theirs-full (repository version), mine-conflict / theirs-conflict (only the conflicted hunks).',
      params: {
        paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Conflicted paths to resolve.' },
        accept: { type: 'string', enum: ['working', 'base', 'mine-conflict', 'theirs-conflict', 'mine-full', 'theirs-full', 'edit', 'launch'], description: 'Which version to accept (default "working").' },
        recursive: { type: 'boolean', description: 'Resolve directories recursively (default false).' },
      },
    },
    {
      name: 'svn_delete', readOnly: false,
      description: 'Delete files or directories from version control (schedules them for removal; commit to finalize). Use keepLocal to keep the local copy while removing from the repository.',
      params: {
        paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths to delete.' },
        keepLocal: { type: 'boolean', description: 'Keep the local file/directory, only schedule removal from version control (default false).' },
      },
    },
    {
      name: 'svn_mkdir', readOnly: false,
      description: 'Create a directory in the working copy (or directly in the repository when given a URL) and schedule it for addition.',
      params: {
        paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Directories to create (paths or repository URLs).' },
        parents: { type: 'boolean', description: 'Create intermediate parent directories as needed (default false).' },
      },
    },
    {
      name: 'svn_propget', readOnly: true,
      description: 'Read the value of a versioned property (e.g. svn:ignore, svn:eol-style, svn:mime-type) on a file or directory.',
      params: {
        name: { type: 'string', required: true, description: 'Property name, e.g. "svn:ignore".' },
        path: { type: 'string', description: 'Target path (default: the workspace root).' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' },
      },
    },
    {
      name: 'svn_propset', readOnly: false,
      description: 'Set a versioned property (e.g. svn:ignore, svn:eol-style) on a file or directory. The value is written to a UTF-8 temp file, so Chinese values are safe.',
      params: {
        name: { type: 'string', required: true, description: 'Property name, e.g. "svn:ignore".' },
        value: { type: 'string', required: true, description: 'Property value (multi-line allowed).' },
        path: { type: 'string', description: 'Target path (default: the workspace root).' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' },
        force: { type: 'boolean', description: 'Overwrite existing property (default false).' },
      },
    },
    {
      name: 'svn_proplist', readOnly: true,
      description: 'List all versioned properties on a file or directory with their values.',
      params: {
        path: { type: 'string', description: 'Target path (default: the workspace root).' },
        verbose: { type: 'boolean', description: 'Include property values (default false).' },
      },
    },
    {
      name: 'svn_propdel', readOnly: false,
      description: 'Remove a versioned property (e.g. svn:ignore) from a file or directory.',
      params: {
        name: { type: 'string', required: true, description: 'Property name to remove.' },
        path: { type: 'string', description: 'Target path (default: the workspace root).' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' },
      },
    },
    {
      name: 'svn_blame', readOnly: true,
      description: 'Show per-line attribution of a file: which revision and author last changed each line. Great for tracing who changed what.',
      params: {
        path: { type: 'string', required: true, description: 'File path to blame.' },
        revision: { type: 'string', description: 'Optional revision to blame (e.g. "123" or "HEAD").' },
      },
    },
    {
      name: 'svn_list', readOnly: true,
      description: 'List the entries of a repository directory (working-copy path or repository URL) without a working copy.',
      params: {
        target: { type: 'string', description: 'Directory path or repository URL (default: the workspace root).' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' },
      },
    },
    {
      name: 'svn_cat', readOnly: true,
      description: 'Print the content of a file from the working copy or directly from the repository (by URL or path with revision).',
      params: {
        target: { type: 'string', required: true, description: 'File path or repository URL.' },
        revision: { type: 'string', description: 'Optional revision (e.g. "123" or "HEAD").' },
      },
    },
    {
      name: 'svn_checkout', readOnly: false, timeoutMs: 300000,
      description: 'Check out a working copy from a repository URL into a local directory (default: <workspace>/<repository basename>).',
      params: {
        url: { type: 'string', required: true, description: 'Repository URL, e.g. svn://host/repo/trunk.' },
        path: { type: 'string', description: 'Local directory to check out into (default: workspace root + repository basename).' },
        revision: { type: 'string', description: 'Optional revision to check out (e.g. "123" or "HEAD").' },
      },
    },
    {
      name: 'svn_switch', readOnly: false, timeoutMs: 300000,
      description: 'Switch the working copy (or one path within it) to another repository URL — e.g. from trunk to a branch.',
      params: {
        url: { type: 'string', required: true, description: 'Target repository URL, e.g. svn://host/repo/branches/feature-x.' },
        path: { type: 'string', description: 'Path to switch (default: the workspace root).' },
        revision: { type: 'string', description: 'Optional revision.' },
        ignoreAncestry: { type: 'boolean', description: 'Disable merge tracking during switch (default false).' },
      },
    },
    {
      name: 'svn_copy', readOnly: false, timeoutMs: 120000,
      description: 'Copy a file, directory, or repository URL to another location (working copy or URL) — the standard way to create branches and tags. Optionally with a log message for remote copies.',
      params: {
        source: { type: 'string', required: true, description: 'Source path or repository URL.' },
        destination: { type: 'string', required: true, description: 'Destination path or repository URL.' },
        message: { type: 'string', description: 'Log message (required when copying to a repository URL).' },
        parents: { type: 'boolean', description: 'Create missing parent directories (default false).' },
      },
    },
    {
      name: 'svn_move', readOnly: false, timeoutMs: 120000,
      description: 'Move or rename a file/directory within the working copy or repository, preserving history.',
      params: {
        source: { type: 'string', required: true, description: 'Source path.' },
        destination: { type: 'string', required: true, description: 'Destination path.' },
        message: { type: 'string', description: 'Log message (required when moving in the repository by URL).' },
      },
    },
    {
      name: 'svn_merge', readOnly: false, timeoutMs: 300000,
      description: 'Merge changes from a source branch/URL into the working copy (or a target path). Use revision like "123:456" to merge a range, or dryRun to preview without touching the working copy.',
      params: {
        source: { type: 'string', required: true, description: 'Source repository URL or path.' },
        target: { type: 'string', description: 'Target path to merge into (default: the workspace root).' },
        revision: { type: 'string', description: 'Optional revision range like "123:456".' },
        dryRun: { type: 'boolean', description: 'Preview the merge result without modifying the working copy (default false).' },
      },
    },
    {
      name: 'svn_mergeinfo', readOnly: true,
      description: 'Show merge tracking information: which revisions of the source have been merged into the target (and which have not).',
      params: {
        source: { type: 'string', required: true, description: 'Source repository URL.' },
        target: { type: 'string', description: 'Target path or URL (default: the workspace root).' },
        showMerged: { type: 'boolean', description: 'Show merged revisions; when false shows unmerged (eligible) revisions (default false).' },
      },
    },
    {
      name: 'svn_lock', readOnly: false,
      description: 'Lock files in the repository (lock-modify-unlock workflow; especially useful for binary assets like .uasset).',
      params: {
        paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths to lock.' },
        message: { type: 'string', description: 'Optional lock comment.' },
      },
    },
    {
      name: 'svn_unlock', readOnly: false,
      description: 'Unlock files in the repository. Use force to break someone else\'s lock.',
      params: {
        paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths to unlock.' },
        force: { type: 'boolean', description: 'Break the lock even if owned by someone else (default false).' },
      },
    },
    {
      name: 'svn_changelist', readOnly: false,
      description: 'Group paths into named changelists (action "set"), remove paths from their changelist (action "remove"), or list all changelists (action "list"). Useful to organize one commit.',
      params: {
        action: { type: 'string', enum: ['set', 'remove', 'list'], description: 'set = assign paths to a changelist (default), remove = unassign paths, list = show all changelists.' },
        name: { type: 'string', description: 'Changelist name (required for action "set").' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Paths to assign/remove (required for set/remove).' },
      },
    },
    {
      name: 'svn_import', readOnly: false, timeoutMs: 300000,
      description: 'Import an unversioned directory tree into the repository at the given URL.',
      params: {
        path: { type: 'string', required: true, description: 'Local directory to import.' },
        url: { type: 'string', required: true, description: 'Repository URL to import into.' },
        message: { type: 'string', required: true, description: 'Log message (Chinese OK).' },
      },
    },
    {
      name: 'svn_export', readOnly: true, timeoutMs: 300000,
      description: 'Export a clean copy of a file/directory from the working copy or repository (no .svn metadata).',
      params: {
        target: { type: 'string', required: true, description: 'Source path or repository URL.' },
        path: { type: 'string', description: 'Destination directory (default: exported into the workspace).' },
        revision: { type: 'string', description: 'Optional revision.' },
        force: { type: 'boolean', description: 'Overwrite existing destination (default false).' },
      },
    },
    {
      name: 'svn_relocate', readOnly: false,
      description: 'Update the repository URL recorded in the working copy after the server address changed.',
      params: {
        from: { type: 'string', required: true, description: 'Old repository root URL.' },
        to: { type: 'string', required: true, description: 'New repository root URL.' },
        path: { type: 'string', description: 'Working-copy path to relocate (default: the workspace root).' },
      },
    },
    {
      name: 'svn_patch', readOnly: false, timeoutMs: 120000,
      description: 'Apply a unified diff patch file to the working copy. Use dryRun to preview.',
      params: {
        patchFile: { type: 'string', required: true, description: 'Path to the .patch / .diff file.' },
        path: { type: 'string', description: 'Working-copy root to apply against (default: the workspace root).' },
        dryRun: { type: 'boolean', description: 'Preview without applying (default false).' },
        reverse: { type: 'boolean', description: 'Apply the patch in reverse (default false).' },
      },
    },
    {
      name: 'svn_upgrade', readOnly: false,
      description: 'Upgrade the working copy format to the current svn client version. Run when svn reports the working copy is too old.',
      params: {
        path: { type: 'string', description: 'Working-copy path to upgrade (default: the workspace root).' },
      },
    },
  ];
  for (const spec of EXTENDED_TOOLS) {
    ctx.tools.register(tool(spec.name, spec.description, spec.params, {
      timeoutMs: spec.timeoutMs ?? 60000,
      readOnly: spec.readOnly ?? false,
      execute: async (args, exec) => {
        const cwd = toolCwd(exec) ?? '.';
        const fn = {
          svn_cleanup: svnCleanup, svn_resolve: svnResolve, svn_delete: svnDelete, svn_mkdir: svnMkdir,
          svn_propget: svnPropget, svn_propset: svnPropset, svn_proplist: svnProplist, svn_propdel: svnPropdel,
          svn_blame: svnBlame, svn_list: svnList, svn_cat: svnCat, svn_checkout: svnCheckout,
          svn_switch: svnSwitch, svn_copy: svnCopy, svn_move: svnMove, svn_merge: svnMerge,
          svn_mergeinfo: svnMergeinfo, svn_lock: svnLock, svn_unlock: svnUnlock, svn_changelist: svnChangelist,
          svn_import: svnImport, svn_export: svnExport, svn_relocate: svnRelocate, svn_patch: svnPatch,
          svn_upgrade: svnUpgrade,
        }[spec.name];
        return fn(cwd, args);
      },
    }));
  }

  // ------------------------------------------------------------- web API
  const api = buildApi(ctx);
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/svn/api',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, ctx.webRuntime?.trustedHosts ?? [])) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } });
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith('/svn/api/') ? pathname.slice('/svn/api/'.length) : undefined;
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown svn API method' } });
        return;
      }
      try {
        const payload = await readJsonBody(req);
        // Defence in depth for 只读模式: the panel already refuses write calls,
        // but a stale bundle (or a manual request) must not slip a write past
        // the mode the user chose either. `commit`/`update`/`add`/… are all in
        // the shared write list; the agent tools are a separate surface and are
        // unaffected by this UI mode.
        if (payload.readOnly === true && WRITE_API_METHODS.has(method)) {
          writeJson(res, 403, {
            ok: false,
            error: { code: 'read-only', message: `只读模式：${method} 是写操作，已拒绝。切回「在线」模式后可用。` },
          });
          return;
        }
        const camel = method.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const handler = api[camel];
        if (handler === undefined) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown svn API method "${method}"` } });
          return;
        }
        writeOk(res, await handler(payload));
      } catch (error) {
        writeError(res, error);
      }
    },
  }), 'dsh-svn-tools: /svn/api routes');
}
