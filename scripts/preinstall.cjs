/**
 * dsh-svn-tools preinstall notice.
 *
 * Up to 0.12.x this script BLOCKED installation unless dsh-better-sidebar was
 * an active bundle layer, because the client half could only register its
 * 'svn' sidebar tab through that service.
 *
 * Since 0.13.0 that is no longer true: the panel renders in either carrier —
 * DSH's own right Sidebar (0.1.5+, and the default under `sidebarCarrier:
 * auto`) or dsh-better-sidebar (kept for older DSH builds and selectable in
 * Settings) — and neither is required, because the 33 `svn_*` agent tools work
 * with no sidebar at all. The check therefore only ADVISES. It never fails an
 * install, and it never changes the installed files.
 *
 * Mechanics: `dsh plugin add` forwards to pnpm with cwd = the profile
 * directory, and pnpm/npm set INIT_CWD to that same directory, so this script
 * can read the profile manifest. The signal is the `dsh.profile.bundles` list
 * (not node_modules presence — a package can sit in node_modules without being
 * an active layer, e.g. via auto-installed peer dependencies).
 *
 * Safety rails:
 * - no INIT_CWD            -> not run through a package manager: pass silently
 * - manifest has no        -> not a DSH profile (plain library install): pass
 *   `dsh.profile`
 * - DSH_SVN_TOOLS_SKIP_SIDEBAR_CHECK=1 -> explicit silencer
 *
 * Messages are ASCII-only: dsh console output is English and Windows consoles
 * may run under a non-UTF-8 code page.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OPTIONAL_CARRIER = 'dsh-better-sidebar';

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function main() {
  if (process.env.DSH_SVN_TOOLS_SKIP_SIDEBAR_CHECK === '1') return;

  const initCwd = process.env.INIT_CWD;
  if (!initCwd) return;

  const manifest = readManifest(initCwd);
  if (!manifest || typeof manifest !== 'object' || !manifest.dsh || typeof manifest.dsh !== 'object' || !manifest.dsh.profile) return;

  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  if (bundles.includes(OPTIONAL_CARRIER)) return;

  const profile = path.basename(initCwd);
  process.stdout.write([
    'dsh-svn-tools: this profile has no dsh-better-sidebar layer.',
    "That is fine on DSH 0.1.5+: the SVN panel registers into DSH's own right",
    'Sidebar (Settings -> Plugins -> Plugin configuration -> sidebarCarrier).',
    `Add dsh-better-sidebar (dsh plugin --profile ${profile} add ${OPTIONAL_CARRIER})`,
    'only if this DSH predates the built-in Sidebar or you prefer that carrier.',
    'The 33 svn_* agent tools need no sidebar at all.',
    '',
  ].join('\n'));
}

main();
