import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'tests/desk',outputDir:'test-results-desk',timeout:90_000,workers:1,
  use:{baseURL:'http://127.0.0.1:4175',viewport:{width:1440,height:1000},actionTimeout:15_000,screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'node scripts/serve-desk.mjs',port:4175,reuseExistingServer:false},
});
