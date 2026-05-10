const { execFileSync } = require('child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { readFileSync } = require('fs');

const html = readFileSync('index.html', 'utf8');
const scripts = [];
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let match;

while ((match = scriptRe.exec(html)) !== null) {
  const attrs = match[1] || '';
  const body = match[2] || '';
  if (/\bsrc\s*=/.test(attrs)) continue;

  const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1];
  if (type && !/^(text|application)\/javascript$|^module$/i.test(type)) continue;

  scripts.push(body);
}

if (scripts.length === 0) {
  throw new Error('No inline JavaScript found in index.html');
}

const dir = mkdtempSync(join(tmpdir(), 'neon-siege-check-'));
const file = join(dir, 'index-inline.js');

try {
  writeFileSync(file, scripts.join('\n'), 'utf8');
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
