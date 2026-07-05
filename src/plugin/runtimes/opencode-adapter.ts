import type { AgentAdapter, AdapterStartInput, DispatchHandle, OpencodeAdapterDeps } from './types';

export function createOpencodeAdapter(deps: OpencodeAdapterDeps): AgentAdapter {
  return {
    runtime: 'opencode',
    async start(input: AdapterStartInput): Promise<DispatchHandle> {
      const { card } = input;
      let sessionId = input.resumeSessionId;
      let sessionReused = Boolean(sessionId);
      let sessionTitle: string | undefined;
      let sessionCreatedAt: string | undefined;
      let sessionResponse: Awaited<ReturnType<typeof deps.client.session.create>> | undefined;

      if (sessionReused && sessionId) {
        const reuseSourceCard = card.feedbackForCardId
          ? await deps.store.getCard(card.feedbackForCardId)
          : await deps.store.findCardBySessionId(sessionId);
        if (reuseSourceCard?.sessionTitle) {
          sessionTitle = reuseSourceCard.sessionTitle;
          sessionCreatedAt = reuseSourceCard.sessionCreatedAt;
        } else {
          try {
            const sessionResp = await deps.client.session.get({ path: { id: sessionId } });
            if (sessionResp.data) {
              sessionTitle = sessionResp.data.title || undefined;
              if (sessionResp.data.time?.created) {
                sessionCreatedAt = new Date(sessionResp.data.time.created).toISOString();
              }
            }
          } catch {
          }
        }
      }

      if (!sessionId) {
        sessionResponse = await deps.client.session.create({
          body: { title: card.title },
          ...(card.projectDir ? { query: { directory: card.projectDir } } : {}),
        });

        if (!sessionResponse.data) {
          throw new Error('Failed to create session');
        }

        sessionId = sessionResponse.data.id;
        sessionReused = false;
      }

      if (!sessionId) {
        throw new Error('Failed to resolve session');
      }
      const activeSessionId: string = sessionId;

      if (!sessionReused && sessionResponse?.data) {
        sessionTitle = sessionResponse.data.title || undefined;
        if (sessionResponse.data.time?.created) {
          sessionCreatedAt = new Date(sessionResponse.data.time.created).toISOString();
        }
      }

      const startedAt = new Date().toISOString();
      const runId = `opencode-${activeSessionId}-${Date.now()}`;

      await deps.store.updateCard(card.id, {
        status: 'in_progress',
        sessionId: activeSessionId,
        sessionTitle,
        sessionCreatedAt,
        staleStatus: null,
        staleDetectedAt: null,
      });

      deps.trackDispatch(activeSessionId, card.id, input.prompt);

      const promptBody = deps.buildPromptBody({
        model: card.model,
        agentType: card.agentType,
        description: input.prompt,
      });

      try {
        await deps.runCommandThenPrompt({
          runCommand: (options) => deps.client.session.command(options),
          runPrompt: () => deps.client.session.promptAsync({
            path: { id: activeSessionId },
            body: promptBody,
            ...(card.projectDir ? { query: { directory: card.projectDir } } : {}),
          }),
          showToast: (options) => deps.client?.tui?.showToast(options),
          card,
          sessionId: activeSessionId,
        });
      } catch (promptError) {
        if (!sessionReused) {
          throw promptError;
        }

        const fallbackResponse = await deps.client.session.create({
          body: { title: card.title },
          ...(card.projectDir ? { query: { directory: card.projectDir } } : {}),
        });
        if (!fallbackResponse.data) {
          throw new Error('Failed to create fallback session');
        }

        const fallbackSessionId = fallbackResponse.data.id;
        sessionId = fallbackSessionId;
        await deps.store.updateCard(card.id, {
          status: 'in_progress',
          sessionId: fallbackSessionId,
          sessionTitle: fallbackResponse.data.title || undefined,
          sessionCreatedAt: fallbackResponse.data.time?.created
            ? new Date(fallbackResponse.data.time.created).toISOString()
            : undefined,
          staleStatus: null,
          staleDetectedAt: null,
        });
        deps.trackDispatch(fallbackSessionId, card.id, input.prompt);
        await deps.runCommandThenPrompt({
          runCommand: (options) => deps.client.session.command(options),
          runPrompt: () => deps.client.session.promptAsync({
            path: { id: fallbackSessionId },
            body: promptBody,
            ...(card.projectDir ? { query: { directory: card.projectDir } } : {}),
          }),
          showToast: (options) => deps.client?.tui?.showToast(options),
          card,
          sessionId: fallbackSessionId,
        });
      }

      await deps.selectSession?.(sessionId, card.title);

      return {
        sessionId,
        runId,
        startedAt,
        abort: () => {},
        done: Promise.resolve({
          outcome: 'completed',
          result: '',
          durationMs: 0,
        }),
      };
    },
  };
}
