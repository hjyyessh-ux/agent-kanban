import { PROMPT_PROPOSAL_PATH, type PromptModelRef } from '../../../src/core/prompt-proposal';
import type { PromptProposalProvider } from '../utils/prompt-refinement-provider';

/** Server error code (`model_not_allowed`, `provider_not_ready`, …). Never carries upstream text. */
export class PromptRefinementRequestError extends Error {
  constructor(readonly code: string, readonly reason?: string) { super(code); }
}

export async function readRefinementError(res: Response, fallback: string): Promise<PromptRefinementRequestError> {
  try {
    const data = await res.json() as { error?: unknown; reason?: unknown };
    return new PromptRefinementRequestError(typeof data?.error === 'string' ? data.error : fallback,
      typeof data?.reason === 'string' ? data.reason : undefined);
  } catch { return new PromptRefinementRequestError(fallback); }
}

/**
 * Adapter pinned to one server-listed `{provider, model}`. Nothing is sent until
 * `propose` is called (the explicit "AI 제안 생성" click); the server re-validates
 * provider, model and readiness and never re-routes to another provider.
 */
export function serverProposer(ref: PromptModelRef): PromptProposalProvider {
  return {
    provider: ref.provider, model: ref.model, models: [ref.model],
    propose: async ({ source, model, loop }, signal) => {
      const reply = await fetch(PROMPT_PROPOSAL_PATH, {
        method: 'POST', cache: 'no-store', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, provider: ref.provider, model, consent: true, ...(loop ? { loop } : {}) }),
      });
      if (!reply.ok) throw await readRefinementError(reply, 'provider_unavailable');
      return reply.json();
    },
  };
}
