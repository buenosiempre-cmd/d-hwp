import {test,expect} from '@playwright/test';

test('local desk exposes program and license files without upload or arbitrary path access',async({request})=>{
  const page=await request.get('/desk/');
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain('D-HWP');
  expect(page.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(page.headers()['content-security-policy']).toContain('connect-src http://127.0.0.1:4175;');
  expect(page.headers()['cache-control']).toBe('no-store');
  expect((await request.post('/desk/upload',{data:'synthetic document'})).status()).toBe(405);
  expect((await request.get('/.env')).status()).toBe(404);
  expect((await request.get('/desk/%2e%2e%2f.env')).status()).toBe(403);
  expect((await request.get('/desk/',{headers:{Host:'example.invalid'}})).status()).toBe(403);
  expect((await request.get('/licenses/MIT.txt')).status()).toBe(200);
  expect(await (await request.get('/licenses/THIRD_PARTY_NOTICES.md')).text()).toContain('rhwp');
});
