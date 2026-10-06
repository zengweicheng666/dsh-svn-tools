/**
 * README link audit: every in-page anchor must resolve to a heading, the two
 * language files must link to each other, and no heading may collide (GitHub
 * de-duplicates by appending -1, which would break the anchors).
 *
 * Usage: node scripts/verify-readme.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const slug = (s) => s.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5 \-]/g, '').replace(/ /g, '-');

let failures = 0;
const check = (cond, label, detail) => {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('  FAIL ' + label + (detail ? ` — ${detail}` : '')); }
};

for (const [file, other] of [['README.md', 'README.en.md'], ['README.en.md', 'README.md']]) {
  console.log(`${file}:`);
  const md = readFileSync(file, 'utf8');
  const headings = [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]));
  const links = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  check(headings.length > 10, `has headings (${headings.length})`);
  check(links.length > 10, `has internal links (${links.length})`);
  const broken = [...new Set(links.filter((l) => !headings.includes(l)))];
  check(broken.length === 0, 'every in-page anchor resolves to a heading', broken.join(', '));
  const dupes = [...new Set(headings.filter((h, i) => headings.indexOf(h) !== i))];
  check(dupes.length === 0, 'no duplicate headings (GitHub would suffix them)', dupes.join(', '));
  check(md.includes(`](${other})`), `links to ${other} (the language switch)`);
  check(existsSync('LICENSE') && md.includes('](LICENSE)'), 'links to an existing LICENSE');
}

console.log('cross-checks:');
const zh = readFileSync('README.md', 'utf8');
const en = readFileSync('README.en.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
check(zh.includes(`v${pkg.version}`) && en.includes(`v${pkg.version}`),
  `both files name the current version (v${pkg.version})`);
check(pkg.files.includes('README.en.md'), 'package.json ships README.en.md');
check(pkg.files.includes('LICENSE') && pkg.files.includes('README.md'), 'package.json ships LICENSE and README.md');

// The documented tool list must match the code's registrations.
const host = readFileSync('lib/index.js', 'utf8');
const registered = [...host.matchAll(/tool\('(svn_[a-z]+)'/g)].map((m) => m[1]);
const withExtras = new Set(registered);
for (const m of host.matchAll(/name: '(svn_[a-z]+)'/g)) withExtras.add(m[1]);
const documented = [...new Set([...zh.matchAll(/`(svn_[a-z]+)`/g)].map((m) => m[1]))];
const missing = [...withExtras].filter((t) => !documented.includes(t));
const extra = documented.filter((t) => !withExtras.has(t));
check(missing.length === 0, 'every registered svn_* tool is documented in README.md', missing.join(', '));
check(extra.length === 0, 'README.md documents no non-existent tool', extra.join(', '));
check(en.includes(`${withExtras.size} `) || en.includes(`${withExtras.size}\``), `README.en.md states the tool count (${withExtras.size})`);

// Every settings key must appear in both tables.
const defaultsStart = host.indexOf('SETTINGS_DEFAULTS = Object.freeze({');
const defaultsEnd = host.indexOf('});', defaultsStart);
const defaults = host.slice(defaultsStart, defaultsEnd);
const keys = [...defaults.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]);
check(keys.length === 10, `the code declares ${keys.length} settings`, keys.join(', '));
for (const k of keys) {
  check(zh.includes('`' + k + '`') && en.includes('`' + k + '`'), `setting ${k} documented in both languages`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nALL README CHECKS PASSED');
