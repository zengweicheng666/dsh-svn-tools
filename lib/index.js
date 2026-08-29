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
