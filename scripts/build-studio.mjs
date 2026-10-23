import {build} from 'vite';
import {readFileSync} from 'node:fs';
import {staticVersion} from './static-version.mjs';
import {validatePreparedBootstrap,validateBootstrapHtml} from './studio-bootstrap.mjs';
validatePreparedBootstrap();
await build({configFile:'studio/vite.config.ts'});
validateBootstrapHtml(readFileSync('dist/studio/index.html','utf8'),staticVersion());
