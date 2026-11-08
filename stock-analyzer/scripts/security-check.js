// Static security gate — run with `npm run check` (also before every deploy).
// Fails (exit 1) if any dangerous pattern appears in shipped code.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const report = (file, line, msg) => problems.push(`${path.relative(ROOT, file)}:${line}  ${msg}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

const clientFiles = walk(path.join(ROOT, 'public')).filter((f) => f.endsWith('.js'));
const serverFiles = [path.join(ROOT, 'server.js'), ...walk(path.join(ROOT, 'lib'))];

// Patterns that must never appear in browser code (DOM XSS sinks, dynamic code).
const CLIENT_RULES = [
  [/\.innerHTML\s*[+]?=/, 'innerHTML assignment (XSS sink) — use textContent / h()'],
  [/\.outerHTML\s*=/, 'outerHTML assignment (XSS sink)'],
  [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML (XSS sink)'],
  [/document\.write\s*\(/, 'document.write'],
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/set(Timeout|Interval)\s*\(\s*['"`]/, 'string passed to setTimeout/setInterval'],
  [/javascript:/i, 'javascript: URL'],
  [/srcdoc/i, 'iframe srcdoc'],
  [/setAttribute\(\s*['"](on\w+|style|href|src)['"]/, 'setAttribute of event handler / style / URL — use the safe h() helper'],
  [/createContextualFragment|DOMParser\(\)\.parseFromString/, 'HTML parsing of strings'],
  [/postMessage\(.*['"]\*['"]/, 'postMessage to "*"'],
];

// Patterns that must never appear in server code.
const SERVER_RULES = [
  [/child_process/, 'child_process import'],
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/\b(writeFile|appendFile|createWriteStream|unlink|rmSync|rm)\s*\(/, 'filesystem write/delete in the server'],
  [/unsafe-inline|unsafe-eval/, "CSP 'unsafe-inline' / 'unsafe-eval'"],
  [/Access-Control-Allow-Origin/, 'CORS opened'],
  [/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/, 'TLS verification disabled'],
];

const SECRET_RULES = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i, 'hard-coded credential'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'API secret key'],
];

function scan(files, rules) {
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((ln, k) => {
      if (/^\s*\/\//.test(ln)) return; // comment lines
      if (ln.includes('security-check: allow')) return; // reviewed, validated sink (explained on the same line)
      for (const [re, msg] of rules) if (re.test(ln)) report(f, k + 1, msg);
    });
  }
}

scan(clientFiles, CLIENT_RULES);
scan(serverFiles, SERVER_RULES);
scan([...clientFiles, ...serverFiles, ...walk(path.join(ROOT, 'scripts')), path.join(ROOT, 'package.json')], SECRET_RULES);

// HTML: no inline scripts, styles or event-handler attributes (CSP stays strict).
for (const f of walk(path.join(ROOT, 'public')).filter((x) => x.endsWith('.html'))) {
  readFileSync(f, 'utf8').split('\n').forEach((ln, k) => {
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(ln)) report(f, k + 1, 'inline <script>');
    if (/\sstyle\s*=/i.test(ln)) report(f, k + 1, 'inline style attribute');
    if (/\son[a-z]+\s*=/i.test(ln)) report(f, k + 1, 'inline event handler');
    if (/<style/i.test(ln)) report(f, k + 1, 'inline <style>');
  });
}

// Every outbound host literal in server code must be in the allow-list.
const util = readFileSync(path.join(ROOT, 'lib', 'util.js'), 'utf8');
const allowed = new Set([...util.matchAll(/'([a-z0-9.-]+\.(?:com|net|org))'/g)].map((m) => m[1]));
for (const f of serverFiles) {
  readFileSync(f, 'utf8').split('\n').forEach((ln, k) => {
    for (const m of ln.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      if (['localhost', '127.0.0.1', '0.0.0.0'].includes(host)) continue;
      if (m[0].startsWith('http://')) report(f, k + 1, `plain-http URL ${m[0]}`);
      if (!allowed.has(host)) report(f, k + 1, `outbound host not in ALLOWED_HOSTS: ${host}`);
    }
  });
}

// Supply chain: zero runtime dependencies.
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies || {}).length) report(path.join(ROOT, 'package.json'), 1, `runtime dependencies present: ${Object.keys(pkg.dependencies).join(', ')}`);

if (problems.length) {
  console.error(`Security check FAILED (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Security check passed: ${clientFiles.length} client files, ${serverFiles.length} server files, HTML, host allow-list, secrets, dependencies.`);
