import {verifyOcrRuntime} from '../conversion/ocr.mjs';
import {closeConversionRuntime} from '../conversion/convert.mjs';
import {loadConfig} from './config';
import {HttpSlackApi} from './slack-api';
import {createSlackReceiver, verifyInstallation} from './receiver';
try {
  const config=loadConfig();
  if(config.markdownOcr)await verifyOcrRuntime(config.markdownOcr);
  const api=new HttpSlackApi(config.botToken);
  const identity=await verifyInstallation(api,config);
  const runtime=createSlackReceiver(config,api,identity);
  await runtime.receiver.start({port:config.port,host:config.host??'127.0.0.1'});
  console.log(`Slack 요청 수신 서버: http://${config.host??'127.0.0.1'}:${config.port}/slack/events`);
  let stopping=false;
  const stop=async()=>{
    if(stopping)return;stopping=true;
    await runtime.receiver.stop();await runtime.close();await closeConversionRuntime();
  };
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
} catch {
  console.error('Slack 서버를 시작하지 못했습니다. 환경 설정, 앱 설치와 워크스페이스를 확인하세요.');
  process.exitCode=1;
}
