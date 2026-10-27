// Package an already-built desk. Runtime settings, documents and MCP installations
// are deliberately outside this allowlisted release.
import {build} from 'esbuild';
import {builtinModules} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, join, relative, resolve, sep} from 'node:path';
import {staticVersion} from './static-version.mjs';

const NODE_VERSION = '24.21.0';
const root = process.cwd();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const assetExtensions = new Set(['.html', '.js', '.css', '.json', '.wasm', '.svg', '.ttf', '.woff', '.woff2', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.avif', '.txt', '.md']);

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') &&
    !/[\0-\x1f\x7f]/.test(path) && path.split('/').every(part => part && !part.startsWith('.') && !part.includes(':'));
}
function assetPath(path) {
  return safePath(path) && (assetExtensions.has(extname(path).toLowerCase()) || /^(?:LICENSE|OFL|NOTICE)$/.test(basename(path)));
}
async function readRegularFile(path) {
  const parts = relative(root, path).split(sep);
  if (parts[0] === '..') fail('Release inputs must stay inside the repository.');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      fail('Release inputs must be regular files without symbolic links.');
    }
  }
  return readFile(path);
}
function git(args) {
  return execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
}
function options(args) {
  const parsed = {out: resolve(root, 'dist/desk-release')};
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--out', '--revision'].includes(key) || seen.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) {
      fail('Usage: node scripts/package-desk.mjs [--out NEW_DIRECTORY] [--revision FULL_COMMIT_SHA]');
    }
    seen.add(key);
    parsed[key.slice(2)] = key === '--out' ? resolve(root, args[++index]) : args[++index];
  }
  return parsed;
}

async function packageDesk({out, revision}) {
  if (process.versions.node !== NODE_VERSION) fail(`Packaging requires Node ${NODE_VERSION}.`);
  const head = git(['rev-parse', 'HEAD']);
  revision ??= head;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) || revision !== head) {
    fail('--revision must be the full current checkout commit SHA.');
  }
  for (const input of ['dist/desk', 'dist/studio', 'node_modules', 'src', 'scripts']) {
    const path = resolve(root, input);
    if (out === path || out.startsWith(path + sep)) fail('Output cannot be inside a release input directory.');
  }
  try { await lstat(out); fail('Output directory already exists; choose a new release directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const manifest = JSON.parse(await readRegularFile(resolve(root, 'dist/static-manifest.json')));
  if (!object(manifest) || !/^[a-f0-9]{64}$/.test(manifest.version) || !object(manifest.files) || manifest.version !== staticVersion()) {
    fail('Static build is missing or stale. Run npm run build:desk before packaging.');
  }
  const files = new Map();
  const studioFiles = {};
  for (const [path, record] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (!path.startsWith('studio/')) continue;
    if (!assetPath(path) || !object(record) || !object(record.identity)) fail('Invalid Studio asset record.');
    const representations = {};
    for (const [encoding, suffix] of [['identity', ''], ['br', '.br'], ['gzip', '.gz']]) {
      if (record[encoding] === undefined) continue;
      const item = record[encoding];
      if (!object(item) || item.file !== path + suffix || !Number.isSafeInteger(item.size) || item.size < 0 || !/^"[a-f0-9]{64}"$/.test(item.etag)) {
        fail('Invalid Studio asset representation.');
      }
      const bytes = await readRegularFile(resolve(root, 'dist', item.file));
      if (bytes.length !== item.size || '"' + sha256(bytes) + '"' !== item.etag) fail('Studio assets changed after manifest generation. Rebuild first.');
      files.set('dist/' + item.file, bytes);
      representations[encoding] = {file: item.file, size: item.size, etag: item.etag};
    }
    studioFiles[path] = representations;
  }
  for (const required of ['studio/index.html', 'studio/LICENSE', 'studio/THIRD_PARTY_LICENSES.md', 'studio/fonts/FONTS.md']) {
    if (!studioFiles[required]) fail('Required Studio entry or license is missing.');
  }
  files.set('dist/static-manifest.json', json({version: manifest.version, files: studioFiles}));

  async function collectDesk(folder = '') {
    for (const entry of await readdir(resolve(root, 'dist/desk', folder), {withFileTypes: true})) {
      const path = folder + entry.name;
      if (!safePath(path) || entry.isSymbolicLink()) fail('Unexpected file in the desk build. Rebuild in a clean directory.');
      if (entry.isDirectory()) {
        if (path !== 'assets' && !path.startsWith('assets/')) fail('Unexpected directory in the desk build.');
        await collectDesk(path + '/');
      } else {
        if (!entry.isFile() || !assetPath(path) || (path !== 'index.html' && !path.startsWith('assets/'))) fail('Unexpected file in the desk build.');
        files.set('dist/desk/' + path, await readRegularFile(resolve(root, 'dist/desk', path)));
      }
    }
  }
  await collectDesk();
  const studioBase = `/static/${manifest.version}/studio/`;
  if (!files.has('dist/desk/index.html') || ![...files].some(([path, bytes]) => path.startsWith('dist/desk/') && path.endsWith('.js') && bytes.includes(studioBase))) {
    fail('Desk and Studio builds do not match. Run npm run build:desk before packaging.');
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) files.set(name, await readRegularFile(resolve(root, name)));

  const bundle = await build({
    absWorkingDir: root, entryPoints: ['scripts/serve-desk.mjs'], outfile: join(out, 'server.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: `node${NODE_VERSION}`,
    write: false, metafile: true, sourcemap: false, legalComments: 'linked', logLevel: 'silent',
    banner: {js: `if (process.versions.node !== '${NODE_VERSION}') throw new Error('D-HWP requires Node ${NODE_VERSION}.');`},
  });
  if (bundle.warnings.length) fail('Server bundle produced warnings; inspect its dependencies before releasing.');
  const builtins = new Set(builtinModules.flatMap(name => [name, 'node:' + name]));
  if (Object.values(bundle.metafile.outputs).some(output => output.imports.some(item => item.external && !builtins.has(item.path)))) {
    fail('Server bundle requires an external or native dependency; standalone packaging stopped.');
  }
  for (const item of bundle.outputFiles) {
    const name = relative(out, item.path);
    if (!['server.cjs', 'server.cjs.LEGAL.txt'].includes(name)) fail('Unexpected server bundle output.');
    files.set(name, Buffer.from(item.contents));
  }

  // Keep each bundled dependency's own notices without copying node_modules.
  const dependencies = [];
  const packageRoots = new Set();
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const path = relative(root, resolve(root, input)).split(sep).join('/');
    const marker = path.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    const tail = path.slice(marker + 'node_modules/'.length).split('/');
    packageRoots.add(path.slice(0, marker + 'node_modules/'.length) + tail.slice(0, tail[0].startsWith('@') ? 2 : 1).join('/'));
  }
  for (const path of [...packageRoots].sort()) {
    const pkg = JSON.parse(await readRegularFile(resolve(root, path, 'package.json')));
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(pkg.name) || typeof pkg.version !== 'string' || !/^[a-z0-9][a-z0-9.+_-]{0,127}$/i.test(pkg.version)) fail('Invalid bundled dependency metadata.');
    dependencies.push({name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : 'See package notices'});
    for (const entry of await readdir(resolve(root, path), {withFileTypes: true})) {
      if (/^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(entry.name)) {
        if (!entry.isFile() || !safePath(entry.name)) fail('Bundled dependency notice must be a regular file.');
        files.set(`licenses/npm/${pkg.name}/${pkg.version}/${entry.name}`, await readRegularFile(resolve(root, path, entry.name)));
      }
    }
  }
  files.set('README.md', Buffer.from(`# D-HWP 실행 릴리스\n\nNode ${NODE_VERSION}에서 이 디렉터리를 작업 디렉터리로 지정하고 \`node server.cjs\`를 실행합니다. launchd에서도 같은 WorkingDirectory와 고정된 Node 실행 경로를 사용하세요.\n\n- 먼저 저장소에서 \`npm ci --ignore-scripts\`, \`npm run build:desk\`, \`node scripts/package-desk.mjs --out 새_디렉터리\` 순서로 준비합니다.\n- origin·인증·MCP 설정은 릴리스 밖의 권한 제한 설정으로 제공합니다. 환경 파일, 토큰, 사용자 문서, 비공개 자료와 MCP 설치는 이 패키지에 포함하지 않습니다.\n- Studio·WASM·폰트와 라이선스는 dist/studio에 있습니다. 프로그램 자원과 API가 같은 origin을 사용하도록 배포하세요.\n- release-manifest.json은 각 파일의 SHA-256과 소스 커밋, 빌드 상태를 기록합니다. 설치 후 파일을 수정하지 말고 새 릴리스를 만들어 교체하세요.\n- 이 패키지는 기존 Slack 서버와 별도이며 배포나 서비스 재시작을 수행하지 않습니다.\n`));
  const inventory = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) => [path, {size: bytes.length, sha256: sha256(bytes)}]));
  const release = {
    schemaVersion: 1, name: 'd-hwp-desk', revision,
    sourceDirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
    nodeVersion: NODE_VERSION, staticVersion: manifest.version,
    entry: 'server.cjs', workingDirectory: '.', mcpIncluded: false,
    dependencies, files: inventory,
  };
  release.releaseSha256 = sha256(json(release));
  files.set('release-manifest.json', json(release));

  let created = false;
  try {
    await mkdir(dirname(out), {recursive: true});
    await mkdir(out); // Exclusive creation prevents replacing an earlier release.
    created = true;
    for (const [path, bytes] of files) {
      const target = join(out, path);
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, bytes, {flag: 'wx', mode: 0o644});
    }
  } catch (error) {
    if (created) await rm(out, {recursive: true, force: true});
    throw error;
  }
  return {out, revision, sourceDirty: release.sourceDirty, staticVersion: manifest.version, releaseSha256: release.releaseSha256, files: files.size};
}

try {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
    console.log('Usage: node scripts/package-desk.mjs [--out NEW_DIRECTORY] [--revision FULL_COMMIT_SHA]\nRun npm run build:desk first. Requires Node ' + NODE_VERSION + '.');
  } else console.log(JSON.stringify(await packageDesk(options(process.argv.slice(2)))));
} catch (error) {
  // Do not serialize esbuild diagnostics, environment values or subprocess output.
  console.error('D-HWP packaging failed: ' + (error.errors ? 'Server bundle could not be produced.' : error.code ? 'A required file or directory could not be accessed.' : error.message));
  process.exitCode = 1;
}
