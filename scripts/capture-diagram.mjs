import { chromium } from '@playwright/test';
import path from 'node:path';
const out = path.resolve('outputs/slides/img');
const file = 'file://' + path.resolve('outputs/slides/diagram.html');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1680, height: 1200 }, deviceScaleFactor: 2 });
await p.goto(file);
await p.waitForTimeout(400);
for (const id of ['diag-arch','diag-flow']) {
  const el = await p.$('#'+id);
  await el.screenshot({ path: path.join(out, id==='diag-arch'?'00-arch.png':'00b-flow.png') });
}
await b.close();
console.log('diagrams captured');
