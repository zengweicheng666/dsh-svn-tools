<div align="right">

[简体中文](README.md) · **English**

</div>

# dsh-svn-tools

> **Subversion tooling and a sidebar panel for DeepSeek Harness.**
> A complete `svn_*` toolset for the agent, plus an SVN panel that renders in **DSH's built-in right Sidebar** (or dsh-better-sidebar) — both halves share one execution core.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.0--rc.6-4c8bf5.svg)](#dsh-version-compatibility)
[![tools](https://img.shields.io/badge/agent%20tools-33-2ea44f.svg)](#agent-tools-33)
[![verified](https://img.shields.io/badge/verified-0.1.6%20%7C%200.2.0--rc.2-8957e5.svg)](#verification-and-development)

**No hard dependency**: the panel carrier is configurable and can be disabled entirely (agent tools only); the package runs **no install-time scripts**.

---

## Contents

- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Sidebar panel](#sidebar-panel)
  - [Carriers](#carriers) · [Changes](#changes) · [Commit](#commit) · [History](#history) · [Online / offline / read-only](#online--offline--read-only)
- [Agent tools (33)](#agent-tools-33)
- [Settings (10)](#settings-10)
- [DSH version compatibility](#dsh-version-compatibility)
- [Updates and install form](#updates-and-install-form)
- [Security model](#security-model)
- [Verification and development](#verification-and-development)
- [FAQ](#faq)
- [License](#license)

---

## Features

| | |
|---|---|
| **33 `svn_*` agent tools** | Full subcommand coverage: status, diff, history, properties, branch/merge, locking, changelists, import/export; Chinese commit messages go through a UTF-8 temp file + `--encoding utf-8`, avoiding Windows GBK console mangling |
| **One panel, two carriers** | Renders in **DSH's built-in right Sidebar** (a `kind: svn` tab plus a guide entry) or in **dsh-better-sidebar**; switchable in Settings, with automatic fallback when one is unavailable, and `off` when neither exists |
| **Side-by-side revision compare** | Repository BASE on the left, working copy on the right; diff-block navigation plus "take left / take right / keep both", writing straight to the working-copy file |
| **Works when the server is down** | Offline history comes from the local log cache plus `.svn/wc.db` revision metadata; read-only mode disables writes with a second server-side check |
| **Commit preparation** | Unversioned `?` files are `svn add`ed and missing `!` files `svn delete`d before committing — with honest reporting (including failures) and a switch for each action |
| **Two DSH generations** | Compatible with `>=0.1.0-rc.6`; the settings surface adapts per version (0.1.x namespace card / 0.2.x entry-config form) |

## Install

Install from the [DSH plugin market](https://awesome-dsh-plugin.com/p/zengweicheng666/dsh-svn-tools/), or pick one of the command-line forms:

```sh
# Recommended: bare repository spec — both the update checker and the market track new versions
dsh plugin --profile web add github:zengweicheng666/dsh-svn-tools

# Pin a version (reproducible install; see "Updates and install form" for the trade-off)
dsh plugin --profile web add github:zengweicheng666/dsh-svn-tools#v0.13.4

# Local source checkout
dsh plugin --profile web add file:./plugins/dsh-svn-tools
```

**Restart dsh after installing** (the host half registers the settings surface and the sidebar tab). With `file:` installs, also add `dsh-svn-tools` to `dsh.profile.bundles` in the profile `package.json`.

**Requirements**

- The `svn` command-line client on `PATH` (or point `svnPath` at it in Settings).
- A carrier for the panel: DSH `0.1.0-rc.6+` already ships the built-in Sidebar; older builds need [dsh-better-sidebar](https://github.com/omdsh-dev/dsh-better-sidebar). With neither, the panel is not registered — **the agent tools are unaffected**.
- Output decoding prefers UTF-8 and falls back to GBK (Chinese Windows consoles).

## Quick start

1. After the restart, open the **SVN** tab in the right Sidebar (or the SVN entry in the guide).
2. The panel treats the current **session working directory** as the working copy; if it is not one, a checkout form is shown.
3. Review the changes, write a message in **Commit** (`✨ Generate message` uses the current model), and commit.
4. Or just ask the agent — e.g. "run `svn_status` to list my changes, then `svn_commit`".

---

## Sidebar panel

### Carriers

One panel renders in either carrier with **identical behaviour**; switching takes effect immediately (an open SVN tab closes — reopen it). The carrier is resolved from the host's settings **before the panel mounts**, so configuring `off` / `better-sidebar` never flashes a built-in tab first.

| `sidebarCarrier` | Meaning |
|---|---|
| `auto` (default) | Use DSH's built-in Sidebar when available (`0.1.0-rc.6+`), otherwise fall back to dsh-better-sidebar |
| `native` | Built-in Sidebar only (a right-Sidebar tab, also listed in the guide) |
| `better-sidebar` | dsh-better-sidebar only (the choice for older DSH builds) |
| `off` | Register no panel at all — the 33 agent tools keep working |

### Changes

- **List**: status badges plus changelist tags; click a row to highlight it, hover for **Compare**, double-click to open the diff.
- **Marquee select**: press and drag to highlight several rows (highlight only, no checkboxes); clicking any row in the group — or toggling any checkbox in it — then applies that row's checked state to the whole group (about 0.25 s later; a double-click into the diff cancels it, so a group is never flipped by accident).
- **Side-by-side compare**: equal-width columns that wrap instead of truncating, red/green line highlighting, switchable back to a plain text diff.
- **Diff navigation**: `◀ Prev / Next ▶` jumps between diff blocks, scrolling the target block into view and highlighting it, with a `position / total` counter; the bar sticks to the top.
- **Diff-block actions**: hover any block to "take left / take right / keep both (left first) / keep both (right first)", applied directly to the working-copy file.
- **Row actions**: `Compare`, `Add` (unversioned), `Delete`, `Revert` (confirm dialog), `Blame` (per line), `Resolve` (conflicted `C`: mine / repository / base / keep current), `Ignore` (writes `svn:ignore`).
- **Batch toolbar**: shows `Delete / Revert` for the current selection (same semantics as the row buttons; unversioned `?` and conflicted `C` are excluded; hidden with no selection; one confirmation, then the selection is cleared).
- **Toolbar**: `Branches` (list and switch), `Cleanup` (`svn cleanup`), `Update`.

### Commit

- Tick files or commit everything; Chinese messages go through a UTF-8 temp file, and `✨ Generate message` uses the current model. The new revision is shown after a commit.
- **Scope coupling**: enabling "commit all changes" ticks every visible file, disabling clears them; ticking any file in the list switches to "commit selected", and unticking the last one stops at "nothing selected" (commit disabled — it does not silently jump back to commit-all).
- **AI analyses only the commit scope**: commit-all means every visible change, a partial selection means exactly those files, unticked files are never analysed, and the button is disabled for an empty scope.
- **"Show unversioned files"**: its initial state comes from `showUnversionedDefault`; unticking hides `?` files **and excludes them from commit-all and from the AI analysis** (they are never auto-added or committed). Missing `!` files are unaffected and still auto-deleted.
- **Commit preparation**: unversioned `?` files are `svn add`ed and missing `!` files `svn delete`d (for commit-all, across the selected directories), with the results reported in the notice bar; with either switch off, those files are left alone and listed separately.

### History

- **List**: the newest N entries (N = `historyPageSize`, default 30); **Load older revisions** appends the same page size until r1, after which the button reads "all N revisions shown".
- **Detail**: click a revision for a split view (list above, that revision's message and changed paths below) with a draggable divider; hover **Compare** or double-click a path for a **read-only** side-by-side diff against the previous revision (same compare view; non-ASCII paths are read through percent-encoded repository URLs).
- **File list**: checkboxes are always visible (always multi-select); interaction matches the Changes list (row click, marquee, group sync).
- **Row and batch actions** (working copy only — **never committed for you**; the files reappear as `M/A/D` on the Commit page for you to decide):

| Action | Semantics |
|---|---|
| **Undo rN changes** | `svn merge -r rN:rN-1` merged back into that file; changes made after rN are kept. Text may show conflict markers and binaries may conflict (resolve on the Commit page); files added in rN are correctly scheduled for deletion and files deleted in rN are scheduled for restore |
| **Restore to before the change** | Overwrites the working-copy file with the content of its **previous modifying revision** (prevRev), streamed via `svn cat` into a temp file so binaries of any size work; changes after rN and local uncommitted edits are discarded; files added in rN are deleted, files deleted in rN are restored and scheduled for addition. When BASE already *is* that previous revision, the local pristine copy is used (a plain `svn revert`) with no network access |
| **Revert to this revision** | Overwrites the working-copy file with its content at rN; files deleted in rN are removed from the working copy, files added in rN are written and scheduled for addition; when BASE is rN the local pristine copy is used with no network access. On the r1 row only this action is offered |

- **Batch**: the toolbar always shows Select all / Clear; the three batch actions appear according to the selection (undo/restore are hidden when the r1 row is included). One confirmation, then files are processed serially (avoiding working-copy lock conflicts); failures are recorded and the run continues, summarising success/failure at the end. Switching revisions clears the selection.
- **Progress**: the row being processed is highlighted with an inline spinner and restored when it finishes.

### Online / offline / read-only

A mode chip (Online / Offline / Read-only) is always visible in the header, next to `Offline`, `Read-only` and `Refresh` switches; entering offline or read-only shows a banner explaining the cause and the consequences. **Offline is a temporary state — there is no "always offline"**: every Retry re-probes the server and restores online data on success.

While **offline**, `svn log` is unavailable, so the history list is built from two sources, each labelled on the entry:

1. **Local log cache** — every successful online `svn log` (message, author, date, changed paths) is stored in the working copy's `.svn/dsh-history-cache.json` (falling back to `%LOCALAPPDATA%\dsh-svn-tools\history\`), reused offline and labelled `cache`;
2. **Working-copy revision metadata** — rebuilt from `.svn/wc.db` (`NODES.changed_revision/changed_author/changed_date`) for the **current working-copy subtree** only, labelled `local metadata`.

SVN does not store commit messages in the working copy, so those entries state that no log text exists and deleted files cannot be recovered; the banner says the data is **incomplete, possibly stale and even misleading** (matching TortoiseSVN's offline notice).

- While offline, **every write is greyed out** (commit/add/delete/revert/restore/update/lock…): they either need the server or would produce local changes that cannot be committed. Viewing, comparing and blaming are unaffected.
- History **Compare** still works: `.svn/pristine` holds the **real repository content** of the revision the working copy currently has, so the locally available side of an rN↔rN-1 comparison is shown as usual (the banner notes that only that side is reflected); a revision that is not available locally is labelled "not available locally" instead of "does not exist". Restore actions run only when the target revision can be **proven** to be the locally held one; otherwise they fail with a readable "cannot be done offline" — offline never turns "undo rN" into a wrong "added in rN" guess that deletes a file.
- **Read-only**: online but with all writes disabled (`Read-only` button, or "leave read-only" in the banner) — handy to prevent accidental edits while browsing. The server also rejects write requests carrying `readOnly` (defence in depth; `export` counts as a write).
- **Automatic degradation**: an operation that needs the server and hits a transport error (`E170013` unreachable, `E210005` no repository at that URL) switches the panel to offline and keeps the message; `E210005` additionally explains that the server is reachable but the URL no longer hosts a repository (renamed/removed/disabled). Other svn errors (conflicts, not a working copy, permissions) are reported as errors and never treated as offline.

---

## Agent tools (33)

| Category | Tools |
|---|---|
| Status / info | `svn_status` (with changelist grouping) · `svn_info` |
| Diff / history | `svn_diff` · `svn_log` · `svn_blame` (per-line attribution) |
| Repository browsing | `svn_list` · `svn_cat` (read the repository without a working copy; paths and `svn://` URLs both work) |
| Changes | `svn_add` · `svn_delete` · `svn_mkdir` · `svn_copy` (branches/tags) · `svn_move` · `svn_revert` (optional `-R`) |
| Commit | `svn_commit` (UTF-8 Chinese messages) |
| Update / checkout | `svn_update` · `svn_checkout` · `svn_switch` · `svn_relocate` · `svn_upgrade` |
| Conflicts / cleanup | `svn_resolve` (mine/theirs/base/working) · `svn_cleanup` |
| Properties | `svn_propget` · `svn_propset` · `svn_proplist` · `svn_propdel` (`svn:ignore` and friends) |
| Branch / merge | `svn_merge` · `svn_mergeinfo` |
| Locking | `svn_lock` · `svn_unlock` (UE binary assets welcome) |
| Grouping | `svn_changelist` (set / remove / list) |
| Other | `svn_import` · `svn_export` · `svn_patch` |

Conventions:

- Every write passes `--non-interactive`, so nothing can hang an agent session on a prompt.
- Positional operands (property names, URLs, branch paths, `relocate` from/to) reject a leading `-`, so they can never be read as options; path operands are always preceded by `--`.
- Read-only tools (`readOnly: true`) are safe to call concurrently.

---

## Settings (10)

Configuration is declared by the plugin's own `Config` (schemastery). The **entry point depends on the DSH version**, and every value is derived from that schema:

| DSH | Entry point | Stored in | Applies |
|---|---|---|---|
| **0.2.x** | The plugin's own configuration page in the plugin manager (a schema-derived form keyed by the profile entry id) | **profile patch** (the entry's own `config`) | The Loader reloads that entry |
| **0.1.x** | Settings → Plugins → Plugin configuration → the "SVN 工具" card | the `dsh-svn-tools:` section of `$DSH_HOME/settings.yaml` | Immediately, no restart; overridden fields are marked and can be reset individually |

| Setting | Default | Purpose |
|---|---|---|
| `sidebarCarrier` | `auto` | Sidebar carrier: `auto` / `native` / `better-sidebar` / `off` |
| `svnPath` | empty | Path to the `svn` executable; empty means the one on `PATH`. `svnversion` is looked up next to it, falling back to `PATH`. The 0.1.x card offers a Probe (`svn --version --quiet`) |
| `commandTimeoutScale` | `1` | Command-timeout multiplier (0.2–20) applied to every svn command's default timeout (60 s normally, 300 s for update/commit); raise to 2–3 on slow servers or huge working copies |
| `historyPageSize` | `30` | Entries per history page, and how many "load older revisions" appends (5–200) |
| `historyCacheEnabled` | `true` | Cache fetched `svn log` output in `.svn/dsh-history-cache.json` so History keeps working when the server is unreachable |
| `historyCacheMaxEntries` | `20000` | Per-working-copy cache bound (100–200000), keeping the newest revisions |
| `autoAddUnversioned` | `true` | `svn add` selected unversioned `?` files before committing; when off they are not added and are listed as skipped |
| `autoDeleteMissing` | `true` | `svn delete` versioned-but-missing `!` files before committing; when off they are listed as skipped |
| `showUnversionedDefault` | `true` | Initial state of "show unversioned files" on the Commit page (still toggleable in the panel) |
| `defaultView` | `commit` | Page the panel opens on: `commit` / `history` / `locks` |

Invalid values (a misspelled carrier, an out-of-range number) are rejected by the schema: the 0.2.x form refuses the input, and on 0.1.x a hand-edited `settings.yaml` makes DSH keep the previous usable value with a warning — in the worst case namespace registration fails and the plugin runs on its built-in defaults.

---

## DSH version compatibility

- `peerDependencies`: `@deepseek-ai/dsh-tools: >=0.1.0-rc.6`, with `engines.dsh: >=0.1.0-rc.6` declared as well.
  The built-in sidebar exists from `0.1.0-rc.6` on, so the criterion is "rc.6 and everything above", not per-major-line ranges.
- DSH's plugin compatibility gate (`evaluatePluginCompatibility` in `dsh-app-boot`) only inspects `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers through
  `semver.satisfies(runtime, range, { includePrerelease: true })`, so prereleases take part in the comparison.
- The plugin market (`dshmarket`) decides with `deriveHostCompatibility`, treating `engines.dsh` and the peers as **conjunctive** conditions.
- Verified on real runtimes: **0.1.6** and **0.2.0-rc.2** (with all peer dependencies). Both the gate's and the market's own evaluation functions were run against this manifest: `0.1.0-rc.6` / `0.1.5-rc.1` / `0.1.6-alpha.1` / `0.2.0-rc.2` / `0.2.1-alpha.1` / `0.3.0-rc.1` are all compatible; `0.1.0-rc.5` is rejected.

## Updates and install form

[dsh-update-checker](https://github.com/Airmetro/dsh-update-checker) and the plugin market are two independent channels, and **which one can notify you depends on the install form**:

- The checker needs two things: a **`repository` field** in the installed copy's `package.json` (declared since 0.13.0) and a **GitHub Release** in the repository (published as `v<version>` here).
  It compares **version numbers**, so tag- and commit-pinned installs are notified too.
- The market compares **ref / commit identity**: a bare repository spec follows the default branch, while a spec with a ref (`#v0.13.4` or `#<commit>`) makes the market report "up to date" for that ref **forever** — that is what pinning means (reproducibility first), not a bug.

| Your goal | Do this |
|---|---|
| Follow releases | Install the bare repository spec, or install straight from the market entry |
| Reproducible install | Install `#v<version>`; upgrade through the checker's notification (it writes back a new tag pin) |
| Drop a pin | Re-install the bare repository spec |

Release notes live in [Releases](https://github.com/zengweicheng666/dsh-svn-tools/releases).

## Security model

- **Same-origin fence**: every panel request goes through the host's `/svn/api/*`. That route requires a loopback or trusted `Host`, rejects `Sec-Fetch-Site: cross-site`, and compares the `Origin`'s **full authority (including port)** with the `Host` — mirroring DSH's own `api-request-trust`. Non-POST requests, paths outside `/svn/api/`, and unknown methods get 404/405.
- **Read-only, twice**: the client greys out write buttons, and the server answers 403 for write methods carrying `readOnly` (including `export`).
- **Arguments and paths**: no shell is involved (argv arrays only); repository URLs are passed through verbatim instead of being treated as file paths; positional operands such as property names, URLs and branch paths reject a leading `-` (blocking injections like `--config-dir=`, which could make svn execute an external program); repository-relative paths used by history restore are checked for **filesystem containment** and reject `..` and absolute paths.
- **No install-time scripts** (since 0.13.3): no `preinstall`/`postinstall`, so nothing needs a dependency-script approval and no per-version entries accumulate in the profile's `allowBuilds`.
- The plugin reads and writes working copies, invokes `svn`, and (per your settings) talks to the repository over the network and to your local model for message generation. It writes nowhere else.

## Verification and development

```sh
npm run verify:hardening      # pure Node: URL passthrough, operand-injection guard, commit-repair result shape
npm run verify:settings       # pure Node: carrier resolution/fallback, settings store, registration bookkeeping, settings card
npm run verify:offline        # pure Node: offline/read-only policy, three-mode rendering, "no permanent offline"
npm run verify:readme         # pure Node: both READMEs' anchors/switcher/License, tool and settings tables vs. the code
npm run verify:settings:host  # needs a real working copy: namespace and defaults, invalid-value rejection, svnPath/timeout in effect
npm run verify:offline:host   # needs a real working copy: local history and paging, connection classification, read-only refusal, offline restore safety
```

The first three need only Node (plus React for the static renders); the last two take a working-copy path (`verify:offline:host` defaults to the current directory).

Repository layout:

```
lib/index.js          Host half: the 33 agent tools, /svn/api/*, settings resolution, offline/read-only policy
lib/client.js         Browser half: the panel, carrier registration, the settings card (no build step; react comes from the shell)
cordis.patch.yml      Profile-layer composition (entry id svn-tools)
scripts/verify-*.mjs  The self-check scripts above
```

## FAQ

<details>
<summary><b>The panel does not show up</b></summary>

Check the carrier: `sidebarCarrier: off` registers no panel; `native` needs DSH `0.1.0-rc.6+`'s built-in Sidebar; `better-sidebar` needs dsh-better-sidebar installed. `auto` picks whichever is available. After changing settings, reload the plugin entry (0.2.x) or restart dsh.

</details>

<details>
<summary><b>No update notification</b></summary>

The checker requires a `repository` field in the installed copy and a GitHub Release — see [Updates and install form](#updates-and-install-form). Copies older than 0.13.0 lack the field and need one manual upgrade to enter the notification loop. If you installed with a spec that carries a ref, the market will never notify you: that is what pinning means — use the checker's notification, or re-install the bare repository spec.

</details>

<details>
<summary><b>Chinese commit messages come out mangled</b></summary>

The plugin always commits through a UTF-8 temp file with `--encoding utf-8 -F`, and decodes command output as UTF-8 first with a GBK fallback. If it still misbehaves, the `svn` client is usually too old, or the system locale forces a non-UTF-8 conversion.

</details>

<details>
<summary><b>Why is <code>export</code> blocked in read-only mode?</b></summary>

`svn export` writes a tree of files to a directory you name (overwriting with `--force`), so since 0.13.3 it counts as a write.

</details>

<details>
<summary><b>The compatibility gate refused my install</b></summary>

The declared peer is `>=0.1.0-rc.6`, which admits 0.1.0-rc.6 and every later release and prerelease. If you were rejected, install a version `>= 0.13.2` — earlier ones declared `^0.1.0-rc.6` and are refused by the 0.2.x gate.

</details>

## License

[MIT](LICENSE)
