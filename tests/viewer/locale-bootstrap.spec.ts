import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync('dist/static-manifest.json','utf8'));
for(const [query,stored,blocked,want] of [['?lang=en','ko',false,'en'],['?lang=ko-KR','en',false,'ko'],['?lang=fr','en',false,'en'],['','fr',false,'ko'],['','en',true,'ko']] as const){
 test(`locale before module: ${query||'default'} / ${stored} / blocked=${blocked}`,async({page})=>{
  await page.addInitScript(({stored,blocked})=>{
   if(blocked)Object.defineProperty(window,'localStorage',{get(){throw new Error('storage blocked');}});
   else localStorage.setItem('rhwp-locale',stored);
  },{stored,blocked});
  let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  await page.route('**/studio/assets/*.js',async route=>{await gate;await route.continue();});
  try{
   await page.goto(`http://127.0.0.1:4174/static/${manifest.version}/studio/${query}`,{waitUntil:'commit'});
   await expect(page.locator('html')).toHaveAttribute('lang',want);
   const response=await page.request.get(`http://127.0.0.1:4174/static/${manifest.version}/studio/locale-init.js`);
   expect(response.status()).toBe(200);expect(response.headers()['content-type']).toMatch(/javascript/);
   release();await page.waitForLoadState('networkidle');
   await expect(page.locator('html')).toHaveAttribute('lang',want);
  }finally{release();}
 });
}
