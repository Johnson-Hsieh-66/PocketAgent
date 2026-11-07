import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

const cwd = process.cwd();
const failures = new Set();
const git = (...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Unable to inspect the Git file inventory.');
  return result.stdout;
};
const tracked = git('ls-files', '--cached', '-z').split('\0').filter(Boolean);
const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
const inventory = [...new Set([...tracked, ...untracked])];
const trackedSet = new Set(tracked);
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['API credential', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/],
  ['GitHub credential', /\b(?:gh[opsru]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['JWT credential', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
  ['personal Windows path', /\b[A-Z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|\b)|<|example(?:[\\/]|\b)|demo(?:[\\/]|\b)|user(?:[\\/]|\b))[A-Za-z0-9_. -]+[\\/]/i],
  ['personal Unix path', /\/(?:Users|home)\/(?!<|example(?:\/|\b)|demo(?:\/|\b)|user(?:\/|\b))[A-Za-z0-9_.-]+\//],
];
const allowedAddresses = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255', '100.64.0.0', '100.127.255.255']);
function flag(file, category) { failures.add(`${file}: ${category}`); }
function inspectText(file, content) {
  for (const [category, pattern] of rules) if (pattern.test(content)) flag(file, category);
  for (const match of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const address = match[0];
    const octets = address.split('.').map(Number);
    if (octets.some(octet => octet > 255)) continue;
    if (allowedAddresses.has(address)) continue;
    if (address.startsWith('192.0.2.') || address.startsWith('198.51.100.') || address.startsWith('203.0.113.')) continue;
    // Dotted version numbers and URI examples can resemble IPv4; allow version context only.
    const prefix = content.slice(Math.max(0, match.index - 18), match.index);
    if (/(?:version|target|rust|node|npm)[\s"':=v-]*$/i.test(prefix)) continue;
    flag(file, 'non-placeholder IPv4 address');
  }
}
for (const file of inventory) {
  const normalized = file.replaceAll('\\', '/');
  if (/(?:^|\/)(?:\.codex|\.aws|sessions|archived_sessions|uploads|runtime|\.data|\.local|logs)(?:\/|$)/i.test(normalized) ||
      /(?:^|\/)(?:auth|credentials)\.json$/i.test(normalized) ||
      /\.(?:sqlite(?:-wal|-shm)?|sqlite3|db|log|jsonl|pem|key|pfx|p12)$/i.test(normalized) ||
      /(?:^|\/)\.env(?:\..+)?$/i.test(normalized) && !/\.env\.(?:example|template)$/.test(normalized) ||
      /(?:^|\/)config\.local\./i.test(normalized)) flag(file, 'runtime or credential file');
  const fullPath = resolve(cwd, file);
  const relativePath = relative(cwd, fullPath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) { flag(file, 'outside checkout'); continue; }
  try {
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) { flag(file, 'symbolic link requires review'); continue; }
    if (stat.isFile()) {
      if (stat.size > 4 * 1024 * 1024) { flag(file, 'large source file requires review'); continue; }
      const bytes = readFileSync(fullPath);
      if (bytes.includes(0)) { flag(file, 'binary file requires review'); continue; }
      inspectText(file, bytes.toString('utf8'));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') flag(file, 'unreadable file');
  }
  if (trackedSet.has(file)) {
    const staged = spawnSync('git', ['show', `:${file}`], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (staged.status !== 0) flag(file, 'unable to inspect staged content');
    else inspectText(file, staged.stdout);
  }
}
if (failures.size) {
  console.error('Public repository check failed. Matched values are intentionally omitted.');
  for (const failure of [...failures].sort()) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Public repository check passed (${inventory.length} source files; working and staged content inspected).`);
}
