import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createSlackReceiver} from '../../src/server/receiver';
import {EditorApi} from '../slack/editor-support';
import {config,actor,bytes} from '../slack/support';
import {object} from '../../src/server/errors';
test('production HTTP ticket → real Studio edit → isolated validation → Slack upload adapter → real revision PDF',async({page},testInfo)=>{
  const phase=async<T>(name:string,run:()=>Promise<T>):Promise<T>=>test.step(name,async()=>{
    const started=performance.now();console.log(JSON.stringify({event:'smoke_phase_started',phase:name}));
    try{const result=await run();console.log(JSON.stringify({event:'smoke_phase_finished',phase:name,ok:true,durationMs:Math.round(performance.now()-started)}));return result;}
    catch(error){console.log(JSON.stringify({event:'smoke_phase_finished',phase:name,ok:false,durationMs:Math.round(performance.now()-started)}));throw error;}
  });
  const api=new EditorApi(),uploaded=new Map<string,Buffer>();
  const runtime=createSlackReceiver({...config,publicOrigin:'http://127.0.0.1:4176'},api,{botId:'BBOT',botUserId:'UBOT'},
    {download:async()=>bytes,fetcher:async(url,options)=>{uploaded.set(new URL(String(url)).pathname.split('/').pop()!,Buffer.from(options!.body as Uint8Array));return new Response('ok');}});
  await runtime.receiver.start({host:'127.0.0.1',port:4176});
  try{
    const {id}=runtime.preparations.submit(actor,'FTEST','open','browser');await phase('prepare-original',()=>runtime.preparations.idle());
    await runtime.documents!.present(id,actor,'browser.trigger');
    const metadata=object(api.calls.find(c=>c.method==='entity.presentDetails')!.args.metadata);
    const preview=object(object(object(metadata.entity_payload).attributes).full_size_preview);
    await phase('open-original',async()=>{await page.goto(String(preview.preview_url));await expect(page.locator('#save-to-slack')).toBeVisible({timeout:60_000});});
    const input=page.frameLocator('#editor iframe').getByLabel('문서 편집 입력',{exact:true});await input.focus();await input.pressSequentially('Saved revision ');
    await phase('save-revision',async()=>{await expect(page).toHaveTitle(/^\* /);await page.locator('#save-to-slack').click();await expect(page).toHaveTitle('문서.hwp · D-HWP',{timeout:60_000});});
    await phase('revision-pdf',async()=>{await expect(page.locator('#slack-save p')).toHaveText('편집본과 PDF를 Slack에 저장했습니다.',{timeout:60_000});await runtime.documents!.pdf.idle();});
    const completions=api.calls.filter(c=>c.method==='files.completeUploadExternal');expect(completions).toHaveLength(7);
    for(const call of completions){expect(call.args.channel_id).toBeUndefined();expect(call.args.thread_ts).toBeUndefined();}
    const posts=api.calls.filter(c=>c.method==='chat.postMessage');expect(posts).toHaveLength(2);expect(posts[1].args.thread_ts).toBe('123.456');
    const edited=[...api.files.values()].find(f=>String(f.name).endsWith('_편집본_1.hwp'))!;
    const revisionPdf=[...api.files.values()].find(f=>String(f.name).endsWith('_편집본_1.pdf'))!;
    expect(edited).toBeTruthy();expect(revisionPdf).toBeTruthy();
    writeFileSync(testInfo.outputPath('slack-edited.hwp'),uploaded.get(String(edited.id))!);
    const pdf=uploaded.get(String(revisionPdf.id))!;expect(pdf.subarray(0,5).toString()).toBe('%PDF-');writeFileSync(testInfo.outputPath('slack-edited.pdf'),pdf);
    const entities=object(posts[1].args.metadata).entities as Record<string,unknown>[];
    const revisionId=String(object(entities[0].external_ref).id);
    expect(runtime.documents!.source(revisionId)).toEqual(uploaded.get(String(edited.id)));
    await runtime.documents!.present(revisionId,actor,'revision.trigger');
    const latest=api.calls.filter(c=>c.method==='entity.presentDetails').at(-1)!;
    const revisionPreview=object(object(object(object(latest.args.metadata).entity_payload).attributes).full_size_preview);
    await phase('reopen-revision',async()=>{
    await page.goto('about:blank'); // Opening another Work Object creates a fresh embed.
    await page.goto(String(revisionPreview.preview_url));
    await expect(page.locator('#save-to-slack')).toBeVisible({timeout:60_000});
    await expect(page).toHaveTitle('문서_편집본_1.hwp · D-HWP');
    });
    const pngFile=[...api.files.values()].find(f=>String(f.name).endsWith('_편집본_1_01페이지.png'))!;
    const png=uploaded.get(String(pngFile.id))!;expect(png.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');writeFileSync(testInfo.outputPath('slack-edited-thumbnail.png'),png);
    expect(runtime.documents!.source(id)).toEqual(bytes);expect(readFileSync('tests/fixtures/viewer-two-pages.hwp')).toEqual(bytes);
    await page.setViewportSize({width:669,height:863});await page.screenshot({path:testInfo.outputPath('slack-production-flow.png')});
  }finally{
    // Chromium can retain speculative TCP connections with no HTTP request. Bolt's
    // server.close() waits for those connections; release the client owner first.
    try{await phase('close-browser-context',()=>page.context().close());}
    finally{try{await phase('stop-receiver',()=>runtime.receiver.stop());}
      finally{await phase('close-runtime',()=>runtime.close());}}
  }
});
