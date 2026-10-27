import {mkdir, writeFile} from 'node:fs/promises';
import {randomBytes, scryptSync} from 'node:crypto';
import {resolve, join} from 'node:path';

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out'||!args[1])throw new Error('Usage: node scripts/create-desk-auth.mjs --out <new-private-directory>');
const out=resolve(args[1]);
// Refuse existing directories to avoid silently replacing live credentials.
await mkdir(out,{mode:0o700});
const password=randomBytes(24).toString('base64url');
const salt=randomBytes(16);
const config={version:1,salt:salt.toString('hex'),passwordHash:scryptSync(password,salt,32).toString('hex')};
await writeFile(join(out,'auth.json'),JSON.stringify(config)+'\n',{mode:0o600,flag:'wx'});
await writeFile(join(out,'access.txt'),`D-HWP CoP 임시 접속 비밀번호\n\n${password}\n\n구성원에게만 별도로 전달하세요. Git·보고서·공개 메시지에 넣지 마세요.\n비밀번호 변경 시 새 인증 폴더를 만들고 서비스의 DHWP_DESK_AUTH_FILE을 변경한 뒤 재시작하세요. 재시작하면 기존 세션이 모두 만료됩니다.\n`,{mode:0o600,flag:'wx'});
console.log(`Authentication files created in ${out}. Password is only in access.txt.`);
