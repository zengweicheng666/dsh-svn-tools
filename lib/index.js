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
