import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const spec = JSON.parse(readFileSync('studio/upstream.json', 'utf8'));
const cache = resolve('.cache');
mkdirSync(cache, {recursive:true});
const archive = resolve(cache, 'studio.tar');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (!existsSync(archive)) execFileSync('python3', ['scripts/prepare-studio-archive.py'], {stdio:'inherit',timeout:600_000});
if (hash(readFileSync(archive)) !== spec.archiveSha256) throw new Error('Studio source archive integrity mismatch');
const source = resolve(cache, 'studio-source');
mkdirSync(source, {recursive:true});
execFileSync('tar', ['-xf', archive, '-C', source]);
const studio = resolve(source, 'rhwp-studio');
const lockHash = hash(readFileSync(resolve(studio, 'package-lock.json')));
const stamp = resolve(studio, 'node_modules/.rhwp-slack-lock');
if (!existsSync(stamp) || readFileSync(stamp,'utf8') !== lockHash) {
  execFileSync('npm', ['ci', '--prefix', studio, '--ignore-scripts', '--no-audit', '--no-fund'], {stdio:'inherit'});
  writeFileSync(stamp, lockHash);
}
// Only static editor resources; omit sample documents and offline service workers.
const publicDir = resolve(cache, 'studio-public');
rmSync(publicDir, {recursive:true,force:true});
mkdirSync(publicDir, {recursive:true});
for (const name of ['fonts','icons','images','favicon.ico','theme-init.js','locale-init.js']) {
  cpSync(resolve(studio, 'public', name), resolve(publicDir, name), {recursive:true, dereference:true});
}
cpSync(resolve(source,'LICENSE'), resolve(publicDir,'LICENSE'));
cpSync(resolve(source,'THIRD_PARTY_LICENSES.md'), resolve(publicDir,'THIRD_PARTY_LICENSES.md'));
console.log(`Prepared verified Studio ${spec.version} (${spec.commit})`);
