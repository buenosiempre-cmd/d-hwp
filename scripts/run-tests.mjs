import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const suite=process.argv[2]??'unit';
if (!['unit','slack','security','deployment'].includes(suite)) throw new Error('Unknown test suite');
const files = (await readdir(`tests/${suite}`)).filter(f=>/\.test\.(ts|mjs)$/.test(f)).sort().map(f=>`tests/${suite}/${f}`);
if (!files.length) throw new Error('No tests discovered');
const result = spawnSync(process.execPath, ['--import','tsx','--test',...files], { stdio:'inherit' });
process.exit(result.status ?? 1);
