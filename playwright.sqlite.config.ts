import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from './playwright.config';

const home=resolve('.e2e-home-sqlite');
const data=resolve('.e2e-data-sqlite');
const port=24719;
const baseURL='http://127.0.0.1:'+port;
process.env.E2E_BASE_URL=baseURL;
export default defineConfig({
  ...base,
  reporter:'list',
  use:{...base.use,baseURL},
  webServer:{
    command:'bun scripts/test-server.ts',port,reuseExistingServer:false,
    env:{E2E_PORT:String(port),E2E_BOARD_BACKEND:'sqlite',HOME:home,E2E_HOME:home,KANBAN_DATA_DIR:data},
  },
  outputDir:'e2e/results-sqlite',
});
