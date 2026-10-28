// Offline readiness only. Never load environment files, contact Slack, launch a
// browser, install packages, or print configuration and credential values.
import {createHash} from 'node:crypto';
import {access, lstat, readFile, statfs} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const checks = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
  !/[\0-\x1f\x7f]/.test(value) && value.split('/').every(part => part && !part.startsWith('.') && !part.includes(':'));
async function check(name, work) {
  try { await work(); checks.push({name, ok: true}); }
  catch { checks.push({name, ok: false}); }
}
function requireValue(condition) { if (!condition) throw new Error('Runtime check failed'); }
async function read(path) {
  requireValue((await lstat(path)).isFile());
  return readFile(path);
}
async function metadata(path) { return JSON.parse(await read(path)); }

await check('node_24_21_0', async () => requireValue(process.versions.node === '24.21.0'));
await check('required_runtime_files', async () => {
  for (const path of [
    'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'src/server/main.ts', 'src/server/config.ts', 'src/conversion/convert.mjs',
    'src/conversion/validate-child.mjs', 'src/shared/errors.ts',
    'dist/editor/index.html', 'dist/studio/index.html',
    '.cache/conversion/runtime.json', '.cache/conversion/print.js',
    '.cache/conversion/fonts.json', '.cache/conversion/pdf-child.mjs',
    '.cache/conversion/runtime-child.mjs',
  ]) await read(path);
});
await check('pinned_dependencies', async () => {
  const expected = {'@rhwp/core': '0.8.7', '@rhwp/editor': '0.8.7', '@playwright/test': '1.63.0'};
  for (const [name, version] of Object.entries(expected)) requireValue((await metadata(`node_modules/${name}/package.json`)).version === version);
  await import('tsx');
  await import('@slack/bolt');
});
await check('chromium_executable_present', async () => {
  const {chromium} = await import('@playwright/test');
  await access(chromium.executablePath());
});
await check('static_asset_integrity', async () => {
  const manifest = await metadata('dist/static-manifest.json');
  requireValue(plain(manifest) && /^[a-f0-9]{64}$/.test(manifest.version) && plain(manifest.files));
  for (const required of ['editor/index.html', 'studio/index.html']) requireValue(plain(manifest.files[required]));
  for (const [path, record] of Object.entries(manifest.files)) {
    requireValue(safePath(path) && /^(editor|studio)\//.test(path) && plain(record) && plain(record.identity));
    for (const [encoding, suffix] of [['identity', ''], ['br', '.br'], ['gzip', '.gz']]) {
      if (record[encoding] === undefined) continue;
      const item = record[encoding];
      requireValue(plain(item) && item.file === path + suffix && Number.isSafeInteger(item.size) && /^"[a-f0-9]{64}"$/.test(item.etag));
      const bytes = await read(resolve('dist', item.file));
      requireValue(bytes.length === item.size && '"' + digest(bytes) + '"' === item.etag);
    }
  }
});
await check('conversion_asset_integrity', async () => {
  const runtime = await metadata('.cache/conversion/runtime.json');
  requireValue(runtime.schema === 1 && runtime.core === '0.8.7' && runtime.playwright === '1.63.0' && runtime.node === 'v24.21.0');
  const {cacheKey, ...identity} = runtime;
  requireValue(cacheKey === digest(JSON.stringify(identity)) && plain(runtime.hashes));
  for (const path of [
    'node_modules/@rhwp/core/rhwp_bg.wasm', 'node_modules/@rhwp/core/rhwp.js',
    '.cache/conversion/fonts.json', '.cache/conversion/print.js',
    '.cache/conversion/pdf-child.mjs', '.cache/conversion/runtime-child.mjs',
  ]) requireValue(/^[a-f0-9]{64}$/.test(runtime.hashes[path]));
  for (const [path, expected] of Object.entries(runtime.hashes)) {
    requireValue(typeof path === 'string' && /^(?:node_modules\/@rhwp\/core\/[a-zA-Z0-9_.-]+|\.cache\/conversion\/[a-zA-Z0-9_.-]+)$/.test(path));
    requireValue(/^[a-f0-9]{64}$/.test(expected) && digest(await read(path)) === expected);
  }
  const fonts = await metadata('.cache/conversion/fonts.json');
  requireValue(typeof fonts.css === 'string' && plain(fonts.files));
  for (const [url, file] of Object.entries(fonts.files)) {
    requireValue(typeof file === 'string' && /^[a-f0-9]{64}\.woff2$/.test(file) && url === `https://rhwp-fonts.invalid/${file}`);
    requireValue(digest(await read(resolve('.cache/conversion/fonts', file))) === file.slice(0, -6));
  }
});
await check('document_exports_present', async () => {
  const conversion = await import(pathToFileURL(resolve('src/conversion/convert.mjs')).href);
  requireValue(typeof conversion.convertMarkdown === 'function' && conversion.MAX_MARKDOWN_BYTES === 2 * 1024 * 1024 && typeof conversion.convertMarkdownPackage === 'function' && conversion.MAX_MARKDOWN_PACKAGE_BYTES === 50 * 1024 * 1024);
  requireValue(typeof conversion.convertText === 'function' && conversion.MAX_TEXT_BYTES === 2 * 1024 * 1024);
  requireValue(typeof conversion.convertPageZip === 'function' && typeof conversion.convertSelectedPageImages === 'function' && conversion.MAX_ZIP_BYTES === 26 * 1024 * 1024);
  // A valid manifest may still describe an older runtime without these modes.
  requireValue((await read('.cache/conversion/pdf-child.mjs')).includes('getTextFileUnicode'));
  const runtime = await read('.cache/conversion/runtime-child.mjs');
  requireValue(['markdown', 'markdown-package', 'text', 'selected'].every(mode => runtime.includes(mode)));
});
let freeMiB = null;
try { const info = await statfs('.'); freeMiB = Math.floor(info.bavail * info.bsize / 1024 / 1024); } catch {}
const ready = checks.every(item => item.ok);
console.log(JSON.stringify({
  ready, checks, freeMiB, lowDiskSpace: freeMiB !== null && freeMiB < 1024,
  slackCredentials: 'not_checked', slackInstallation: 'not_checked',
  actualConversion: 'not_run', browserLaunch: 'not_run',
}));
if (!ready) process.exitCode = 1;
