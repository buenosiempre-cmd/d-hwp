import {spawnSync} from 'node:child_process';
for(const script of ['typecheck','test','test:slack','test:security','test:viewer','build:desk','test:desk']){
  const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['run',script],{stdio:'inherit'});
  if(result.status!==0){process.exitCode=result.status??1;break;}
}
