import { createPromptRefinementRoute } from '../src/server/prompt-refinement-route';
import { createSyntheticPromptUpstream } from '../src/__tests__/synthetic-prompt-provider';
import {test,expect} from './fixtures/kanban';
import type {Page,Request} from '@playwright/test';
const SOURCE='/review\n프롬프트 다듬기를 개선한다. 배포하지 않는다.';
const PATH='/api/prompt-refinement/proposal';
const SHOTS=process.env.PROMPT_REFINEMENT_SHOTS;
const modal=(page:Page)=>page.getByRole('dialog',{name:'프롬프트 다듬기',exact:true});
const trigger=(page:Page)=>page.getByRole('button',{name:'프롬프트 다듬기',exact:true});
async function composer(page:Page) {
  await page.getByRole('button',{name:'Create new card'}).click();
  await page.locator('#create-card-title-input').fill('프롬프트 다듬기 검증');
  const source=page.locator('#create-card-description-input');
  await source.fill(SOURCE);
  await expect(page.locator('.kv2-dialog--refinement')).toHaveCount(0);
  await expect(trigger(page)).toHaveAttribute('aria-expanded','false');
  await trigger(page).click();
  await expect(modal(page)).toBeVisible();
  return source;
}
async function shot(page:Page,file:string) {
  if(SHOTS) await page.screenshot({path:`${SHOTS}/${file}.png`,animations:'disabled'});
}

for (const width of [1280,390]) test(`refinement modal, model allow-list parity and exact undo (${width}px)`, async({page})=>{
  // Intercept only this route. Browser UI sees a synthetic provider, never production keys.
  const {upstream}=createSyntheticPromptUpstream();
  const synthetic=createPromptRefinementRoute(
    {apiKey:'synthetic-key',model:'synthetic-default',models:['synthetic-default','synthetic-alt']},upstream,
  );
  await page.route('**'+PATH, async route=>{
    const req=route.request();
    const response=await synthetic(new globalThis.Request(req.url(),{
      method:req.method(),headers:req.headers(),body:req.postData()??undefined,
    }));
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  await page.setViewportSize({width,height:width===390?860:930});
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  const proposals:Request[]=[],writes:Request[]=[];
  page.on('request',req=>{
    const path=new URL(req.url()).pathname;
    if(path===PATH&&req.method()==='POST')proposals.push(req);
    if(path.startsWith('/api/cards')&&!['GET','HEAD'].includes(req.method()))writes.push(req);
  });
  await page.goto('/');
  await page.getByRole('tab',{name:'Settings',exact:true}).click();
  const names=page.getByRole('list',{name:'다듬기에 사용 가능한 모델'});
  await expect(names.getByRole('listitem')).toHaveCount(2);
  const allowed=(await names.getByRole('listitem').allTextContents()).map(t=>t.replace(' · 기본',''));
  await page.getByRole('tab',{name:'Board',exact:true}).click();
  const input=await composer(page);
  const pane=modal(page);
  await expect(page.getByRole('dialog')).toHaveCount(1); // the inert parent is excluded
  await expect(page.locator('[role=dialog]')).toHaveCount(2);
  expect(await page.locator('.kv2-dialog--create').evaluate(node=>!!node.closest('[inert]'))).toBe(true);
  await expect(pane.getByRole('checkbox',{name:'완료 조건까지 반복'})).not.toBeChecked();
  await expect(pane.getByRole('radio',{name:'로컬 템플릿'})).toBeChecked();
  await pane.getByRole('button',{name:'제안 검토'}).click();
  await expect(pane.getByText('적용할 제안',{exact:true})).toBeVisible();
  await expect(pane.getByText('중단 조건 · 반복 한도 (제안)',{exact:true})).toHaveCount(0);
  expect(proposals).toHaveLength(0);
  await pane.getByRole('button',{name:'설정으로'}).click();
  await pane.getByRole('radio',{name:'AI 맞춤'}).check();
  const model=pane.getByRole('button',{name:/다듬기 모델/});
  await model.click();
  const list=pane.getByRole('listbox',{name:'다듬기 모델'});
  await expect(list).toBeVisible();
  const available=(await list.getByRole('option').allTextContents()).map(t=>t.replace(/기본|✓/g,''));
  expect(available).toEqual(allowed);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await shot(page,`model-picker-${width}`);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(pane).toBeVisible();
  await model.press('ArrowDown');
  await expect(list.getByRole('option').first()).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(model).toContainText('synthetic-alt');
  await pane.getByRole('checkbox',{name:'완료 조건까지 반복'}).check();
  await pane.getByRole('textbox',{name:'목표 (선택)'}).fill('카드 실행 모델 보존');
  await pane.getByRole('textbox',{name:'완료 조건 (선택, 줄마다 하나)'}).fill('원문 복원');
  expect(proposals).toHaveLength(0);
  await pane.getByRole('button',{name:/AI 제안 생성 · OpenAI \/ synthetic-alt/}).click();
  await expect(pane.getByText('적용할 제안',{exact:true})).toBeVisible();
  expect(proposals).toHaveLength(1);
  expect(proposals[0].postDataJSON()).toMatchObject({source:SOURCE,model:'synthetic-alt',
    loop:{goal:'카드 실행 모델 보존',doneWhen:'원문 복원',maxRounds:3}});
  const omit=pane.getByRole('checkbox',{name:/합성 응답 메타/});
  await omit.uncheck();
  await shot(page,`review-${width}`);
  await pane.getByRole('button',{name:/선택 적용/}).click();
  await expect(pane).toHaveCount(0);
  const applied=await input.inputValue();
  expect(applied).toMatch(/^\/review/);
  expect(applied.startsWith(SOURCE+'\n\n')).toBe(true);
  expect(applied).toContain('원문 복원');
  expect(applied).not.toContain('합성 응답 메타');
  await page.getByRole('button',{name:'되돌리기',exact:true}).click();
  await expect(input).toHaveValue(SOURCE);
  expect(writes).toHaveLength(0);
});

test('unconfigured AI preserves local workflow and Escape stays inside the form',async({page})=>{
  await page.route('**'+PATH,route=>route.fulfill({json:{provider:null}}));
  await page.goto('/');
  const input=await composer(page);
  const pane=modal(page);
  await expect(pane.getByRole('radio',{name:'AI 맞춤'})).toBeDisabled();
  await expect(pane.getByText(/연결된 다듬기 모델이 없습니다/)).toBeVisible();
  await pane.getByRole('button',{name:'제안 검토'}).click();
  await pane.getByRole('button',{name:/선택 적용/}).click();
  await expect(input).not.toHaveValue(SOURCE);
  await page.getByRole('button',{name:'되돌리기',exact:true}).click();
  await expect(input).toHaveValue(SOURCE);
  await page.getByRole('button',{name:'프롬프트 다듬기',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(input).toHaveValue(SOURCE);
  await expect(trigger(page)).toBeFocused();
});

test('local user edits and deselections survive changing loop options',async({page})=>{
  await page.goto('/');
  await composer(page);
  const pane=modal(page);
  await pane.getByRole('checkbox',{name:'완료 조건까지 반복'}).check();
  await pane.getByRole('button',{name:'제안 검토'}).click();
  const typed=pane.getByRole('textbox',{name:'목표 · 확인 필요 (제안)'});
  const summary=pane.locator('summary').filter({hasText:'목표 · 확인 필요 (제안)'});
  if(!(await typed.isVisible()))await summary.click();
  await typed.fill('사용자 편집 보존');
  const stop=pane.getByRole('checkbox',{name:'중단 조건 · 반복 한도 (제안)'});
  await stop.uncheck();
  await pane.getByRole('button',{name:'설정으로'}).click();
  await pane.getByRole('spinbutton',{name:'반복 한도 (회)'}).fill('4');
  await pane.getByRole('button',{name:'제안 검토'}).click();
  if(!(await typed.isVisible()))await summary.click();
  await expect(typed).toHaveValue('사용자 편집 보존');
  await expect(stop).not.toBeChecked();
});

for (const width of [1280,390]) test(`card detail opens a separate modal before editing and applies only to its draft (${width}px)`,
  async ({page, seedCard})=>{
    const title='카드 상세 다듬기 확인 '+width;
    const card=await seedCard({title,description:SOURCE});
    const writes:Request[]=[];
    page.on('request',req=>{
      if(new URL(req.url()).pathname.startsWith('/api/cards')&&!['GET','HEAD'].includes(req.method())) writes.push(req);
    });
    await page.setViewportSize({width,height:width===390?860:930});
    await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
    await page.goto('/');
    await page.getByRole('button',{name:'Open details for '+title,exact:true}).click();
    const detail=page.locator('.kv2-dialog--detail');
    const editor=detail.getByRole('textbox',{name:'Prompt 편집'});
    const pane=modal(page);
    const button=trigger(page);
    await expect(detail).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.kv2-dialog--refinement')).toHaveCount(0);
    expect(writes).toHaveLength(0);
    await shot(page,`detail-initial-${width}`);
    const detailBox=await detail.boundingBox();
    await button.click();
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute('aria-modal','true');
    expect(await detail.boundingBox()).toEqual(detailBox);
    expect(await pane.evaluate(node=>!node.closest('.kv2-dialog--detail'))).toBe(true);
    expect(await detail.evaluate(node=>!!node.closest('[inert]'))).toBe(true);
    const modalBox=await pane.boundingBox();
    expect(modalBox!.x).toBeGreaterThanOrEqual(0);
    expect(modalBox!.x+modalBox!.width).toBeLessThanOrEqual(width);
    const close=pane.getByRole('button',{name:'Close dialog',exact:true});
    const review=pane.getByRole('button',{name:'제안 검토'});
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(review).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await shot(page,`detail-modal-${width}`);
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    await expect(detail).toBeVisible();
    await expect(button).toBeFocused();
    await expect(editor).toHaveCount(0);
    expect(writes).toHaveLength(0);

    await button.click();
    await review.click();
    await expect(pane.getByText('변경 전 원문',{exact:true})).toBeVisible();
    await pane.getByRole('button',{name:/선택 적용/}).click();
    await expect(editor).toHaveValue(/^\/review[\s\S]+\n\n/);
    await expect(pane).toHaveCount(0);
    expect(writes).toHaveLength(0);
    await detail.getByRole('button',{name:'되돌리기',exact:true}).click();
    await expect(editor).toHaveValue(SOURCE);
    expect(writes).toHaveLength(0);

    await editor.fill(SOURCE+'\n편집 중인 초안');
    await button.click();
    await pane.getByRole('button',{name:'취소',exact:true}).click();
    await expect(editor).toHaveValue(SOURCE+'\n편집 중인 초안');
    expect(writes).toHaveLength(0);

    await button.click();
    await review.click();
    await pane.getByRole('button',{name:/선택 적용/}).click();
    const final=await editor.inputValue();
    expect(final).toContain('편집 중인 초안');
    const saved=page.waitForResponse(res=>res.request().method()==='PATCH'&&new URL(res.url()).pathname==='/api/cards/'+card.id);
    await detail.getByRole('button',{name:'Save',exact:true}).click();
    expect((await saved).ok()).toBe(true);
    expect(writes.map(req=>req.method())).toEqual(['PATCH']);
    expect(writes[0].postDataJSON()).toMatchObject({description:final});
  });
