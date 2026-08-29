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
import { execFile } from 'node:child_process';
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

async function svnCat(cwd, args) {
  if (!args.target) throw badRequest('target is required');
  const target = resolveTargetAbs(args.target, cwd);
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

/** Read both sides for one target: BASE via svn cat, working copy from disk. */
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

  api.diff = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    const target = resolveTargetAbs(p.path, cwd);
    if (!target) throw Object.assign(new Error('path is required'), { code: 'bad-request', status: 400 });
    const argv = ['diff'];
    if (p.revision) argv.push('-r', p.revision);
    argv.push('--', target);
    const diff = await runSvn(argv, { cwd, timeout: 120000 });
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

  api.commit = async (p) => {
    const cwd = sessionCwdOf(ctx, p.sessionId, p.cwd);
    if (!p.message || String(p.message).trim() === '') {
      throw Object.assign(new Error('commit message is required'), { code: 'bad-request', status: 400 });
    }
    const logFile = path.join(os.tmpdir(), `dsh-svn-commit-${randomUUID()}.txt`);
    const targets = (p.paths ?? []).map((x) => resolveTargetAbs(x, cwd));
    try {
      await fs.writeFile(logFile, String(p.message), { encoding: 'utf8' });
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
