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
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-svn-tools';
export const inject = ['tools', 'webServer', 'sessions', 'webRuntime', 'agents', 'llm'];

const SVN = process.platform === 'win32' ? 'svn.exe' : 'svn';
const MAX_BODY = 1024 * 1024;

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

/** Run `svn` with an argument array (no shell), returning decoded stdout. */
function runSvn(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(SVN, args, {
      cwd: opts.cwd,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout ?? 60000,
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

/** Resolve a raw path against a base directory; absolute paths pass through. */
function resolveTargetAbs(raw, base) {
  if (!raw) return base;
  if (path.isAbsolute(raw)) return raw;
  return base ? path.resolve(base, raw) : raw;
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
 */
async function prepareForCommit(cwd, targets) {
  const added = [];
  const deleted = [];
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
      await runSvn(['delete', '--non-interactive', '--', t], { cwd, timeout: 60000 }).catch(() => {});
      deleted.push(t);
    } else if (exists && (item === '?' || item === undefined)) {
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
  return { added, deleted };
}

/** Read both sides for one target: BASE via svn cat, working copy from disk. */
/** "svn://host/a/b" -> "/a/b" (no URL parsing needed for svn: URLs). */
function urlPathname(u) {
  const s = String(u ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = s.indexOf('/');
  return slash === -1 ? '' : s.slice(slash);
}

/** `svn cat` one repository URL at revision `rev` (peg = `rev`). The URL's
 * non-ASCII segments must already be percent-encoded so exotic (Chinese /
 * U+2011) paths never hit svn.exe's Windows argv (E155010). Returns null
 * (via the caller's catch) when the path does not exist at that revision. */
async function catUrl(cwd, url, rev) {
  const raw = await new Promise((resolve, reject) => {
    execFile(SVN, ['cat', '--non-interactive', '-r', String(rev), `${url}@${rev}`], {
      cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60000, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(decodeBuffer(stderr).trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
  if (raw.includes(0)) return { binary: true };
  return { binary: false, text: decodeBuffer(raw) };
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

/** All API methods, keyed by URL suffix. Every payload carries sessionId (+ optional cwd). */
function buildApi(ctx) {
  const api = {};

  api.root = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const xml = await runSvn(['info', '--xml', '--', cwd], { cwd, timeout: 30000 });
    return { cwd, ...parseInfo(xml, cwd) };
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
   * appears for locally-held locks. */
  api.locks = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd) ?? cwd;
    const localXml = await runSvn(['status', '--xml', '--', target], { cwd, timeout: 60000 });
    const localPaths = new Set(parseLocks(localXml).map((e) => e.path));
    const allXml = await runSvn(['status', '--xml', '-u', '--', target], { cwd, timeout: 180000 });
    const entries = parseLocks(allXml).map((e) => Object.assign(e, { mine: localPaths.has(e.path) || undefined }));
    return { entries };
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
    const repoRel = typeof p.repoRel === 'string' && p.repoRel.startsWith('/') ? p.repoRel : null;
    const revision = Number(p.revision);
    if (!repoRel || !Number.isInteger(revision) || revision < 1) {
      throw badRequest('repoRel (absolute repo path) and a positive integer revision are required');
    }
    const xml = await runSvn(['info', '--xml', '--', cwd], { cwd, timeout: 30000 });
    const info = parseInfo(xml, cwd);
    if (!info.repositoryRoot || !info.url) throw new Error('无法解析工作副本 URL');
    const rootPath = urlPathname(info.repositoryRoot);
    const wcPath = urlPathname(info.url);
    const suffix = rootPath !== '' && wcPath.startsWith(rootPath) ? wcPath.slice(rootPath.length) : '';
    if (!(suffix !== '' && repoRel.startsWith(suffix + '/'))) {
      throw badRequest(`路径不在当前工作副本内：${repoRel}`);
    }
    const url = info.repositoryRoot.replace(/\/+$/, '') + repoRel.split('/').map(encodeURIComponent).join('/');
    const cat = async (rev) => {
      if (rev < 1) return null;
      try { return await catUrl(cwd, url, rev); }
      catch { return null; }
    };
    const left = await cat(revision);
    const right = await cat(revision - 1);
    if (left?.binary || right?.binary) {
      return { path: repoRel, revision, binary: true, message: '二进制文件，无法左右对比' };
    }
    const pairs = mergeModifiedPairs(alignLines(splitLines(left?.text ?? ''), splitLines(right?.text ?? '')));
    return {
      path: repoRel,
      revision,
      binary: false,
      leftMissing: left === null,
      rightMissing: right === null,
      leftLabel: left === null ? `r${revision}（不存在）` : `r${revision}`,
      rightLabel: right === null ? `r${revision - 1}（不存在）` : `r${revision - 1}`,
      pairs,
      text: pairsToUnified(pairs, repoRel, revision, `r${revision - 1}`),
    };
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

  api.log = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd) ?? cwd;
    const limit = Math.max(1, Math.min(p.limit ?? 20, 200));
    const argv = ['log', '--xml', '-l', String(limit)];
    if (p.verbose) argv.push('-v');
    argv.push('--', target);
    const xml = await runSvn(argv, { cwd, timeout: 60000 });
    return { entries: parseLog(xml) };
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
      // entry, because plain `svn commit` silently skips both.
      let entries = [];
      try {
        const xml = await runSvn(['status', '--xml', '--', cwd], { cwd, timeout: 60000 });
        entries = parseStatus(xml);
      } catch { /* status unavailable — commit as-is */ }
      const pending = entries.filter((e) => e.status === '?' || e.status === '!').map((e) => e.path);
      prepared = pending.length > 0 ? await prepareForCommit(cwd, pending) : { added: [], deleted: [] };
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
      };
    } finally {
      await fs.rm(logFile, { force: true }).catch(() => {});
    }
  };

  api.generateMessage = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);

    // 1. collect working-copy changes
    const xml = await runSvn(['status', '--xml', '--', cwd], { cwd, timeout: 60000 });
    const entries = parseStatus(xml);
    if (entries.length === 0) {
      return { message: '', model: undefined, note: '工作副本没有变更，无需提交' };
    }

    // 2. overall diff (bounded)
    let diff = '';
    try {
      diff = await runSvn(['diff', '--', cwd], { cwd, timeout: 120000 });
    } catch { /* binary-only or empty changes: diff stays empty */ }
    const MAX_DIFF_CHARS = 40000;
    const truncated = diff.length > MAX_DIFF_CHARS;
    if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS) + '\n...(diff 过长，已截断)';

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

export function apply(ctx) {
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
