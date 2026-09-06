/**
 * dsh-svn-tools preinstall guard.
 *
 * Blocks installation when the target DSH profile has not enabled
 * dsh-better-sidebar (the client half of this plugin registers its 'svn'
 * sidebar tab through the betterSidebar service, and that service only
 * exists when dsh-better-sidebar is a profile bundle layer).
 *
 * Mechanics: `dsh plugin add` forwards to pnpm with cwd = the profile
 * directory, and pnpm/npm set INIT_CWD to that same directory, so this
 * script can read the profile manifest. The authoritative signal is the
 * `dsh.profile.bundles` list (not node_modules presence — a package can
 * sit in node_modules without being an active layer, e.g. via
 * auto-installed peer dependencies).
 *
 * Safety rails:
 * - no INIT_CWD            -> not run through a package manager: pass
 * - manifest has no        -> not a DSH profile (plain library install):
 *   `dsh.profile`             pass
 * - DSH_SVN_TOOLS_SKIP_SIDEBAR_CHECK=1 -> explicit escape hatch: pass
 *
 * pnpm 10 blocks dependency lifecycle scripts unless the profile allows
 * them (pnpm approve-builds, or onlyBuiltDependencies in
 * pnpm-workspace.yaml). Without that allowance this check does not run
 * and the runtime guard in lib/client.js is the fallback.
 *
 * Messages are ASCII-only: dsh console output is English and Windows
 * consoles may run under a non-UTF-8 code page.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_BUNDLE = 'dsh-better-sidebar';

function fail(lines) {
  process.stderr.write('dsh-svn-tools: preinstall check failed.\n' + lines.join('\n') + '\n');
  process.exit(1);
}

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
  if (bundles.includes(REQUIRED_BUNDLE)) return;

  const profile = path.basename(initCwd);
  fail([
    `dsh-svn-tools requires the dsh-better-sidebar plugin (its 'svn' sidebar tab`,
    'registers through the betterSidebar service, which only dsh-better-sidebar',
    'provides). Install and enable it in this profile first:',
    '',
    `  dsh plugin --profile ${profile} add dsh-better-sidebar`,
    '',
    'then retry installing dsh-svn-tools.',
    '',
    'The 33 svn_* agent tools do not depend on the sidebar; if you intentionally',
    'install without it, set DSH_SVN_TOOLS_SKIP_SIDEBAR_CHECK=1 to bypass this check.',
  ]);
}

main();
