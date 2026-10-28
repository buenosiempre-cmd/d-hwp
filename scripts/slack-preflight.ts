import {verifyOcrRuntime} from '../src/conversion/ocr.mjs';
// Read-only installation check. Never print credential values or raw Slack responses.
import {access} from 'node:fs/promises';
import {loadConfig} from '../src/server/config';
import {HttpSlackApi} from '../src/server/slack-api';
import {verifyInstallation} from '../src/server/receiver';
try {
  const config=loadConfig();
  if(config.markdownOcr)await verifyOcrRuntime(config.markdownOcr);
  await Promise.all(['dist/editor/index.html','dist/studio/index.html','.cache/conversion/print.js'].map(path=>access(path)));
  await verifyInstallation(new HttpSlackApi(config.botToken),config);
  console.log('토큰의 workspace·bot 신원과 필수 자산 파일 존재 확인 완료. 앱 ID·권한 범위·이벤트 URL·실제 변환/업로드는 별도 확인이 필요합니다.');
}catch{console.error('설정 또는 앱 설치를 확인하지 못했습니다. .env와 빌드 상태를 확인하세요. 비밀값과 원문 응답은 기록하지 않습니다.');process.exitCode=1;}
