import {test,expect} from '@playwright/test';

test('Slack editor provides a local AI panel without altering the document',async({page})=>{
  await page.goto('/editor/?devtools=1');
  await page.waitForFunction(()=>Boolean(window.__studio));
  await page.locator('#file').setInputFiles('tests/fixtures/viewer-two-pages.hwp');
  await expect(page).toHaveTitle('viewer-two-pages.hwp · D-HWP');
  const before=await page.evaluate(()=>window.__studio.getDocumentState());
  await page.getByRole('button',{name:'D-HWP · AI 업무 도우미',exact:true}).click();
  await page.getByRole('button',{name:'문서 전체 가져오기',exact:true}).click();
  await expect(page.getByLabel('문서 내용',{exact:true})).toHaveValue(/한글 문서 미리보기/);
  await page.getByRole('button',{name:'AI 요청문 만들기',exact:true}).click();
  await expect(page.getByLabel('AI 요청문 미리보기',{exact:true})).toHaveValue(/D-HWP 검토 요청/);
  const after=await page.evaluate(()=>window.__studio.getDocumentState());
  expect(after.documentSha256).toBe(before.documentSha256);
  expect(after.dirty).toBe(before.dirty);
  await page.getByRole('button',{name:'업무 도우미 닫기',exact:true}).click();
  await expect(page.locator('#dhwp-assistant')).toBeHidden();
  await expect(page.getByRole('button',{name:'D-HWP · AI 업무 도우미',exact:true})).toBeFocused();
});
