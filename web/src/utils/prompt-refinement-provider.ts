import { PROMPT_MODEL_PATTERN, readPromptProposal, type PromptLoopOptions } from '../../../src/core/prompt-proposal';
import { previewLoopPrompt, type RefinementPreview } from './prompt-refinement';

/** What the client sends. `model` must be one of the server-listed models; the server re-validates. */
export interface PromptProposalInput { skill: string; source: string; model: string; loop?: PromptLoopOptions }
/** A configured adapter must be text-only and unable to access files/tools or run tasks.
 * An adapter is enabled only by explicitly configured server transport. */
export interface PromptProposalProvider {
  provider: string;
  /** Default refinement model (server-chosen). Unrelated to any card's run model. */
  model: string;
  /** Server-managed allow-list; defaults to `[model]`. */
  models?: string[];
  propose: (input: PromptProposalInput, signal: AbortSignal) => Promise<unknown>;
}
export { PROMPT_PROPOSAL_SKILL } from '../../../src/core/prompt-proposal';

export function providerModels(provider: PromptProposalProvider | undefined): string[] {
  if (!provider) return [];
  const list = (provider.models ?? []).filter(m => PROMPT_MODEL_PATTERN.test(m));
  return list.includes(provider.model) ? list : [provider.model, ...list];
}

export function parsePromptProposal(source: string, raw: unknown, loop?: PromptLoopOptions): RefinementPreview {
  const sections = readPromptProposal(source, raw, loop ? [loop.goal, loop.doneWhen] : []).sections.map(({kind,title,body}, index) => {
    const label = kind === 'extracted' ? '원문 발췌' : kind === 'question' ? '확인 필요' : 'AI 제안 · 검토 필요';
    return {id:`ai-${index}`,title:`${title} (${label})`,body};
  });
  // Goals, completion conditions and stop criteria stay explicit even if
  // the model omits or paraphrases them. These are user inputs or local text.
  return { source, sections: loop ? [...sections, ...previewLoopPrompt(source,loop).sections] : sections };
}
