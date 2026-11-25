import {test,expect} from './fixtures/kanban';
import type {Page,Request} from '@playwright/test';
import {buildPromptCatalog} from '../src/server/prompt-refinement-catalog';
import type {PromptReadinessCheck} from '../src/core/prompt-proposal';

/**
 * Refinement model picker (refinement only — card Model Visibility is separate).
 * Multi-model runs use the SYNTHETIC in-process provider (`E2E_SYNTHETIC_PROMPT_PROVIDER=true`):
 * no network, no key, no real model. 1-/0-model and error cases fulfil the catalog in the
 * browser (`page.route`), so no server is reached for them either.
 */
const SOURCE='/review\n프롬프트 다듬기 모델 선택을 검증한다. 배포하지 않는다.';
const PROPOSAL='/api/prompt-refinement/proposal';
const DEFAULT='/api/prompt-refinement/default';
const SHOTS=process.env.PROMPT_REFINEMENT_SHOTS;
const synthetic=process.env.E2E_SYNTHETIC_PROMPT_PROVIDER==='true';
const modal=(page:Page)=>page.getByRole('dialog',{name:'프롬프트 다듬기',exact:true});
const trigger=(page:Page)=>page.getByRole('button',{name:'프롬프트 다듬기',exact:true});
const shot=async(page:Page,file:string)=>{ if(SHOTS) await page.screenshot({path:`${SHOTS}/${file}.png`,animations:'disabled'}); };
const viewport=async(page:Page,width:number)=>{
  await page.setViewportSize({width,height:width===390?860:930});
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
};
const noOverflow=async(page:Page)=>expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

/** proposals = explicit model sends; board = any state change outside refinement (cards, works, settings…). */
function watch(page:Page) {
  const proposals:Request[]=[],board:Request[]=[],defaults:Request[]=[],catalogReads:Request[]=[];
  page.on('request',req=>{
    const path=new URL(req.url()).pathname;
    if(path===PROPOSAL&&req.method()==='POST')proposals.push(req);
    else if(path===PROPOSAL&&req.method()==='GET')catalogReads.push(req);
    else if(path===DEFAULT&&req.method()!=='GET')defaults.push(req);
    else if(path.startsWith('/api/')&&!path.startsWith('/api/e2e/')&&!['GET','HEAD','OPTIONS'].includes(req.method()))board.push(req);
  });
  return {proposals,board,defaults,catalogReads};
}

async function openComposer(page:Page) {
  await page.getByRole('tab',{name:'Board',exact:true}).click();
  await page.getByRole('button',{name:'Create new card'}).click();
  await page.locator('#create-card-title-input').fill('다듬기 모델 선택 검증');
  const source=page.locator('#create-card-description-input');
  await source.fill(SOURCE);
  await trigger(page).click();
  await expect(modal(page)).toBeVisible();
  return source;
}
const picker=(page:Page)=>modal(page).getByRole('button',{name:/다듬기 모델 · 이번 생성에만 적용/});
const option=(page:Page,provider:string,model:string)=>
  modal(page).locator(`[role=option][data-provider="${provider}"][data-model="${model}"]`);

const OK:PromptReadinessCheck[]=[
  {key:'transport',label:'고정 실행 파일',ok:true,detail:'[모킹] 일치'},
  {key:'auth',label:'전용 로그인',ok:true,detail:'[모킹] 확인'},
  {key:'schema',label:'구조화 출력',ok:true,detail:'[모킹] 고정 스키마'},
];
const ONE_MODEL=buildPromptCatalog([{provider:'Codex CLI',configured:true,defaultModel:'gpt-6.1-sol',models:['gpt-6.1-sol'],checks:OK}],null);
const ZERO_MODELS=buildPromptCatalog([{provider:'Codex CLI',configured:true,defaultModel:'gpt-6.1-sol',models:['gpt-6.1-sol'],
  checks:[OK[0],{key:'auth',label:'전용 로그인',ok:false,detail:'[모킹] 전용 로그인 없음 (codex login 미완료)'},OK[2]]}],null);

for (const width of [1280,390]) test(`multi-model (synthetic): settings default persists, modal choice is this-time-only, unsupported never selectable (${width}px)`,
  async ({page})=>{
    test.skip(!synthetic,'Safe in-process synthetic provider is opt-in (E2E_SYNTHETIC_PROMPT_PROVIDER=true).');
    await viewport(page,width);
    expect((await page.request.delete(DEFAULT)).ok()).toBe(true); // isolated .e2e-data only
    const seen=watch(page);
    await page.goto('/');
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    const panel=page.getByRole('region',{name:'다듬기 모델'});
    await expect(panel.getByTestId('refine-default-status')).toHaveText(/저장된 기본값 없음 · 서버 기본값 OpenAI \/ synthetic-default/);
    // Every provider is listed; unavailable ones are visible, disabled, with reason + settings location.
    for (const name of ['Codex CLI','OpenAI','Claude CLI']) await expect(panel.locator(`details[data-provider="${name}"]`)).toHaveCount(1);
    await panel.locator('details[data-provider="OpenCode"] > summary').click();
    await expect(panel.getByRole('radio',{name:'OpenCode / github-copilot/gpt-5.4'})).toBeDisabled();
    await panel.locator('details[data-provider="Codex CLI"] > summary').click();
    const codexRadio=panel.getByRole('radio',{name:'Codex CLI / gpt-6.1-sol'});
    await expect(codexRadio).toBeDisabled();
    await expect(panel.locator('details[data-provider="Codex CLI"]')).toContainText('전용 로그인 없음');
    await expect(panel.locator('details[data-provider="Codex CLI"]')).toContainText('설정 위치');
    await panel.locator('details[data-provider="Claude CLI"] > summary').click();
    await expect(panel.getByRole('radio',{name:'Claude CLI / claude-opus-5-5'})).toBeDisabled();
    await codexRadio.check({force:true}).catch(()=>undefined);
    await expect(codexRadio).not.toBeChecked();
    await expect(panel.getByRole('button',{name:'기본값 저장'})).toBeDisabled();
    // Explicit save of a supported model.
    await panel.getByRole('radio',{name:'OpenAI / synthetic-alt'}).check();
    await panel.getByRole('button',{name:'기본값 저장'}).click();
    await expect(panel.getByTestId('refine-default-status')).toHaveText(/저장된 기본값: OpenAI \/ synthetic-alt/);
    expect(seen.defaults.map(r=>r.method())).toEqual(['PUT']);
    expect(seen.defaults[0].postDataJSON()).toEqual({provider:'OpenAI',model:'synthetic-alt'});
    await noOverflow(page);
    await shot(page,`settings-saved-${width}`);
    // Server-side allow-list: an unsupported model cannot be saved even by a direct request.
    const forced=await page.request.put(DEFAULT,{data:{provider:'Codex CLI',model:'gpt-6.1-sol'}});
    expect(forced.status()).toBe(409);
    // Reload: the saved value comes back from the server's data dir, not from page state.
    await page.reload();
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    await expect(page.getByRole('region',{name:'다듬기 모델'}).getByTestId('refine-default-status'))
      .toHaveText(/저장된 기본값: OpenAI \/ synthetic-alt/);
    await expect(page.getByRole('region',{name:'다듬기 모델'}).getByRole('radio',{name:'OpenAI / synthetic-alt'})).toBeChecked();

    const input=await openComposer(page);
    const pane=modal(page);
    await expect(pane.getByRole('radio',{name:'기본 틀 추가 · AI 호출 없음'})).toBeChecked();
    await pane.getByRole('radio',{name:'AI 맞춤 제안 · 모델 호출'}).check();
    await expect(picker(page)).toContainText('OpenAI / synthetic-alt');
    await expect(pane.getByTestId('refine-choice-scope')).toContainText('기본값 OpenAI / synthetic-alt으로 시작합니다');
    await picker(page).click();
    const list=pane.getByRole('listbox',{name:/다듬기 모델/});
    await expect(list).toBeVisible();
    await expect(list.getByRole('group')).toHaveCount(4);
    await expect(option(page,'OpenCode','github-copilot/gpt-5.4')).toHaveAttribute('aria-disabled','true');
    await expect(option(page,'Codex CLI','gpt-6.1-sol')).toHaveAttribute('aria-disabled','true');
    await expect(option(page,'Codex CLI','gpt-6.1-sol')).toContainText('전용 로그인');
    await expect(option(page,'Claude CLI','claude-opus-5-5')).toHaveAttribute('aria-disabled','true');
    await expect(option(page,'OpenAI','synthetic-alt')).toHaveAttribute('aria-selected','true');
    await noOverflow(page);
    await shot(page,`modal-picker-${width}`);
    await option(page,'Codex CLI','gpt-6.1-sol').click({force:true}); // bypass Playwright's own aria-disabled guard
    await expect(list).toBeVisible(); // a disabled option neither closes nor selects
    await expect(picker(page)).toContainText('OpenAI / synthetic-alt');
    await option(page,'OpenAI','synthetic-default').click();
    await expect(list).toHaveCount(0);
    await expect(picker(page)).toContainText('OpenAI / synthetic-default');
    await expect(pane.getByTestId('refine-choice-scope')).toContainText('이번 생성에만 OpenAI / synthetic-default');
    expect(seen.proposals).toHaveLength(0);
    expect(seen.board).toHaveLength(0);
    await shot(page,`modal-this-time-${width}`);
    await pane.getByRole('button',{name:'AI 제안 생성 · OpenAI / synthetic-default'}).click();
    await expect(pane.getByRole('region',{name:'제안',exact:true})).toBeVisible();
    expect(seen.proposals).toHaveLength(1);
    expect(seen.proposals[0].postDataJSON()).toEqual({source:SOURCE,provider:'OpenAI',model:'synthetic-default',consent:true});
    expect((await (await page.request.get('/api/e2e/prompt-calls')).json()).models.at(-1)).toBe('synthetic-default');
    await expect(pane.getByTestId('refine-review-source')).toContainText('OpenAI / synthetic-default · 이번 생성만');
    // Decision: out of the draft until an option is chosen; the choice is merged verbatim.
    const decide=pane.getByRole('button',{name:/합성 결정.*: 본문에 넣기/});
    await expect(decide).toBeDisabled();
    await expect(pane.getByText('결정 필요 1개는 빼고 적용됩니다')).toBeVisible();
    await pane.getByRole('button',{name:/^결정 필요/}).click();
    await expect(pane.getByRole('article')).toHaveCount(1);
    await shot(page,`split-decision-${width}`);
    await pane.getByRole('radiogroup',{name:/합성 결정.*선택지/}).getByText('합성 선택지 B').click();
    await expect(pane.getByRole('button',{name:/합성 결정.*: 본문에서 빼기/})).toBeEnabled();
    await expect(pane.getByText('결정 필요 1개는 빼고 적용됩니다')).toHaveCount(0);
    await pane.getByRole('button',{name:/^전체/}).click();
    if(width<720) await pane.getByRole('tab',{name:'결과'}).click();
    await expect(pane.getByTestId('refine-result')).toContainText('→ 결정: 합성 선택지 B');
    await shot(page,`split-result-${width}`);
    await pane.getByRole('button',{name:/본문에 적용/}).click();
    await expect(pane).toHaveCount(0);
    const applied=await input.inputValue();
    expect(applied.startsWith(SOURCE+'\n\n')).toBe(true);
    expect(applied).toContain('→ 결정: 합성 선택지 B');
    await page.getByRole('button',{name:'되돌리기',exact:true}).click();
    await expect(input).toHaveValue(SOURCE);
    // The this-time choice was not persisted: a new session starts from the saved default again.
    await trigger(page).click();
    await expect(picker(page)).toContainText('OpenAI / synthetic-alt');
    await modal(page).getByRole('button',{name:'닫기 · 작업 유지',exact:true}).click();
    await expect(input).toHaveValue(SOURCE);
    const after=await (await page.request.get(DEFAULT)).json();
    expect(after.catalog.savedDefault).toEqual({provider:'OpenAI',model:'synthetic-alt',valid:true});
    expect(seen.defaults).toHaveLength(1);
    expect(seen.proposals).toHaveLength(1);
    expect(seen.board).toHaveLength(0);
  });

for (const width of [1280,390]) test(`card detail (synthetic): model change and AI proposal touch only the draft, no board save (${width}px)`,
  async ({page,seedCard})=>{
    test.skip(!synthetic,'Safe in-process synthetic provider is opt-in (E2E_SYNTHETIC_PROMPT_PROVIDER=true).');
    await viewport(page,width);
    expect((await page.request.delete(DEFAULT)).ok()).toBe(true);
    const title='상세 다듬기 모델 '+width;
    await seedCard({title,description:SOURCE});
    const seen=watch(page);
    await page.goto('/');
    await page.getByRole('button',{name:'Open details for '+title,exact:true}).click();
    const detail=page.locator('.kv2-dialog--detail');
    await trigger(page).click();
    const pane=modal(page);
    await pane.getByRole('radio',{name:'AI 맞춤 제안 · 모델 호출'}).check();
    await expect(picker(page)).toContainText('OpenAI / synthetic-default');
    await picker(page).click();
    await option(page,'OpenAI','synthetic-alt').click();
    expect(seen.proposals).toHaveLength(0);
    expect(seen.board).toHaveLength(0);
    await pane.getByRole('button',{name:'AI 제안 생성 · OpenAI / synthetic-alt'}).click();
    await expect(pane.getByRole('region',{name:'제안',exact:true})).toBeVisible();
    expect(seen.proposals.map(r=>r.postDataJSON().model)).toEqual(['synthetic-alt']);
    await noOverflow(page);
    await shot(page,`detail-review-${width}`);
    await pane.getByRole('button',{name:/본문에 적용/}).click();
    const editor=detail.getByRole('textbox',{name:'Prompt 편집'});
    await expect(editor).toHaveValue(/^\/review[\s\S]+\n\n/);
    await detail.getByRole('button',{name:'되돌리기',exact:true}).click();
    await expect(editor).toHaveValue(SOURCE);
    await trigger(page).click();
    await modal(page).getByRole('button',{name:'닫기 · 작업 유지',exact:true}).click();
    await expect(editor).toHaveValue(SOURCE);
    expect(seen.board).toHaveLength(0);
    expect(seen.defaults).toHaveLength(0);
  });

const BOTH=buildPromptCatalog([
  {provider:'Codex CLI',configured:true,defaultModel:'gpt-6.1-sol',models:['gpt-6.1-sol','gpt-6-astra'],checks:OK},
  {provider:'Claude CLI',configured:true,defaultModel:'claude-opus-5-5',models:['claude-opus-5-5','claude-sonnet-5'],checks:OK},
],null);

test('Codex and Claude both selectable (mocked catalog): request stays pinned to the picked provider; modal resizes and keeps state on reopen',async({page})=>{
  await page.setViewportSize({width:1280,height:930});
  await page.route('**'+PROPOSAL,async route=>{
    if(route.request().method()==='GET') return route.fulfill({json:{provider:null,catalog:BOTH}});
    return route.fulfill({json:{sections:[{kind:'suggestion',title:'[모킹] 목적',body:'[모킹 응답 · 실제 모델 아님]'}]}});
  });
  const seen=watch(page);
  await page.goto('/');
  const input=await openComposer(page);
  const pane=modal(page);
  await pane.getByRole('radio',{name:'AI 맞춤 제안 · 모델 호출'}).check();
  await picker(page).click();
  for(const [p,m] of [['Codex CLI','gpt-6.1-sol'],['Codex CLI','gpt-6-astra'],['Claude CLI','claude-opus-5-5'],['Claude CLI','claude-sonnet-5']])
    await expect(option(page,p,m)).not.toHaveAttribute('aria-disabled','true');
  await option(page,'Claude CLI','claude-sonnet-5').click();
  await expect(picker(page)).toContainText('Claude CLI / claude-sonnet-5');
  await pane.getByRole('button',{name:'AI 제안 생성 · Claude CLI / claude-sonnet-5'}).click();
  await expect(pane.getByRole('region',{name:'제안',exact:true})).toBeVisible();
  expect(seen.proposals.map(r=>r.postDataJSON())).toEqual([{source:SOURCE,provider:'Claude CLI',model:'claude-sonnet-5',consent:true}]);
  // Backdrop click must not close; resize is enabled and persisted.
  const dialog=page.locator('.kv2-dialog--refinement');
  expect(await dialog.evaluate(n=>getComputedStyle(n).resize)).toBe('both');
  await page.mouse.click(5,5);
  await expect(pane).toBeVisible();
  await dialog.evaluate(n=>{(n as HTMLElement).style.width='900px';(n as HTMLElement).style.height='640px';});
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('kanban-dialog-size-refinement'))).toContain('900');
  // Close and reopen over the same source: the reviewed proposal and model choice are kept.
  await pane.getByRole('button',{name:'닫기 · 작업 유지',exact:true}).click();
  await expect(pane).toHaveCount(0);
  await trigger(page).click();
  await expect(modal(page).getByText('이전 작업을 이어서 표시합니다',{exact:false})).toBeVisible();
  await expect(modal(page).getByRole('region',{name:'제안',exact:true})).toBeVisible();
  await expect(modal(page).getByTestId('refine-review-source')).toContainText('Claude CLI / claude-sonnet-5');
  await shot(page,'modal-resumed-1280');
  expect(seen.proposals).toHaveLength(1);
  await modal(page).getByRole('button',{name:'새로 시작'}).click();
  await expect(modal(page).getByRole('radio',{name:'기본 틀 추가 · AI 호출 없음'})).toBeChecked();
  await modal(page).getByRole('button',{name:'닫기 · 작업 유지',exact:true}).click();
  await expect(input).toHaveValue(SOURCE);
  expect(seen.board).toHaveLength(0);
});

test('one model (mocked catalog): only that model is selectable; server refusals keep the draft and reload the catalog',async({page})=>{
  await page.route('**'+PROPOSAL,async route=>{
    if(route.request().method()==='GET') return route.fulfill({json:{provider:null,catalog:ONE_MODEL}});
    return route.fulfill({status:503,json:{error:'provider_not_ready'}});
  });
  const seen=watch(page);
  await page.goto('/');
  const input=await openComposer(page);
  const pane=modal(page);
  await pane.getByRole('radio',{name:'AI 맞춤 제안 · 모델 호출'}).check();
  await picker(page).click();
  await expect(pane.locator('[role=option]:not([aria-disabled])')).toHaveCount(1);
  await expect(option(page,'Codex CLI','gpt-6-astra')).toContainText('KANBAN_PROMPT_CODEX_MODELS');
  await page.keyboard.press('Escape');
  const reads=seen.catalogReads.length;
  await pane.getByRole('button',{name:'AI 제안 생성 · Codex CLI / gpt-6.1-sol'}).click();
  await expect(pane.getByRole('alert')).toContainText('연결·로그인 상태가 확인되지 않아 보내지 않았습니다');
  await expect(pane.getByRole('alert')).toContainText('원문은 변경하지 않았습니다');
  expect(seen.proposals).toHaveLength(1);
  expect(seen.proposals[0].postDataJSON()).toMatchObject({provider:'Codex CLI',model:'gpt-6.1-sol'});
  await expect.poll(()=>seen.catalogReads.length).toBeGreaterThan(reads);
  await pane.getByRole('button',{name:'닫기 · 작업 유지',exact:true}).click();
  await expect(input).toHaveValue(SOURCE);
  expect(seen.board).toHaveLength(0);
});

for (const width of [1280,390]) test(`zero selectable models (mocked catalog): AI is disabled with reasons; template adds a fixed frame without network (${width}px)`,
  async({page})=>{
    await viewport(page,width);
    await page.route('**'+PROPOSAL,route=>route.fulfill({json:{provider:null,catalog:ZERO_MODELS}}));
    await page.route('**'+DEFAULT,route=>route.fulfill({json:{catalog:ZERO_MODELS}}));
    const seen=watch(page);
    await page.goto('/');
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    const panel=page.getByRole('region',{name:'다듬기 모델'});
    await expect(panel).toContainText('선택 가능한 다듬기 모델이 없습니다');
    await expect(panel.getByRole('button',{name:'기본값 저장'})).toBeDisabled();
    await shot(page,`settings-zero-${width}`);
    const input=await openComposer(page);
    const pane=modal(page);
    await expect(pane.getByRole('radio',{name:'AI 맞춤 제안 · 모델 호출'})).toBeDisabled();
    await expect(pane.getByText(/선택 가능한 다듬기 모델이 없습니다/)).toBeVisible();
    const note=pane.getByRole('note',{name:'기본 틀 안내'});
    await expect(note).toContainText('기본 틀 추가 · AI 호출 없음 · 네트워크 전송 없음');
    await expect(note).toContainText('## 목표 · 완료 조건 (제안)');
    await expect(note).toContainText('되돌리기');
    await pane.locator('details.kv2-refine-status > summary').click();
    await expect(pane.locator('details.kv2-refine-status')).toContainText('전용 로그인 확인 실패');
    await expect(pane.locator('details.kv2-refine-status')).toContainText('설정 위치');
    await noOverflow(page);
    await shot(page,`modal-zero-${width}`);
    await pane.getByRole('button',{name:'기본 틀 미리보기'}).click();
    await expect(pane.getByTestId('refine-review-source')).toHaveText(/AI 호출 없음 · 네트워크 전송 없음/);
    await pane.getByRole('button',{name:/본문에 적용/}).click();
    const applied=await input.inputValue();
    expect(applied.startsWith(SOURCE+'\n\n## 목표 · 완료 조건 (제안)')).toBe(true);
    await page.getByRole('button',{name:'되돌리기',exact:true}).click();
    await expect(input).toHaveValue(SOURCE);
    expect(seen.proposals).toHaveLength(0);
    expect(seen.defaults).toHaveLength(0);
    expect(seen.board).toHaveLength(0);
  });

test('catalog unavailable (server error): AI disabled, template still works, nothing sent',async({page})=>{
  await page.route('**'+PROPOSAL,route=>route.fulfill({status:401,json:{error:'Unauthorized'}}));
  const seen=watch(page);
  await page.goto('/');
  const input=await openComposer(page);
  const pane=modal(page);
  await expect(pane.getByRole('radio',{name:'AI 맞춤 제안 · 모델 호출'})).toBeDisabled();
  await expect(pane.getByText(/다듬기 모델 상태를 불러오지 못했습니다/)).toBeVisible();
  await pane.getByRole('button',{name:'기본 틀 미리보기'}).click();
  await pane.getByRole('button',{name:/본문에 적용/}).click();
  await expect(input).not.toHaveValue(SOURCE);
  await page.getByRole('button',{name:'되돌리기',exact:true}).click();
  await expect(input).toHaveValue(SOURCE);
  expect(seen.proposals).toHaveLength(0);
  expect(seen.board).toHaveLength(0);
});
