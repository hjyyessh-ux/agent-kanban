import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KanbanCard, KanbanStatus } from "../../../../src/core/types";
import { CardDetailDialog } from "./CardDetailDialog";

function makeCard(status: KanbanStatus): KanbanCard {
  return {
    id: `card-${status}`,
    title: "Card title",
    description: "Prompt body",
    status,
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
  };
}

function renderDialog(card: KanbanCard): string {
  return renderToStaticMarkup(
    <CardDetailDialog
      card={card}
      onClose={mock(() => undefined)}
      onStatusChange={mock(() => true)}
      onDelete={mock(() => true)}
    />,
  );
}

describe("CardDetailDialog", () => {
  test("expands prompt by default in every status", () => {
    for (const status of ["todo", "in_progress", "complete", "done"] as const) {
      const html = renderDialog(makeCard(status));

      expect(html).toContain("kv2-phase-content--expanded");
      expect(html).toContain("hide ▴");
    }
  });

  test("shows the selected GPT-5.6 model in an editable Codex detail card", () => {
    const html = renderToStaticMarkup(
      <CardDetailDialog
        card={{
          ...makeCard("todo"),
          agentRuntime: "codex",
          model: "gpt-5.6-sol",
        }}
        onClose={mock(() => undefined)}
        onStatusChange={mock(() => true)}
        onDelete={mock(() => true)}
        onUpdate={mock(() => undefined)}
      />,
    );

    expect(html).toContain("GPT-5.6-Sol");
    expect(html).toContain("kv2-runtime-trigger");
    expect(html).not.toContain("kv2-runtime-trigger-icon");
  });

  test("keeps actual runtime badges for non-script agent cards", () => {
    for (const [runtime, label, title] of [
      ['opencode', 'OPENCODE', 'Opencode'],
      ['codex', 'CODEX', 'Codex'],
      ['claude', 'CLAUDE', 'Claude'],
    ] as const) {
      const html = renderDialog({
        ...makeCard("complete"),
        agentRuntime: runtime,
        executionKind: 'agent',
      });

      expect(html).toContain(`>${label}</span>`);
      expect(html).toContain(`title="${title} runtime"`);
      expect(html).toContain('>Runtime</span>');
      expect(html).not.toContain('>SCRIPT</span>');
    }
  });

  test("shows scheduled dispatch status and Start Now copy for scheduled todo cards", () => {
    const html = renderToStaticMarkup(
      <CardDetailDialog
        card={{
          ...makeCard("todo"),
          scheduledDispatch: {
            scheduledAt: "2026-07-18T00:30:00.000Z",
            status: "scheduled",
            updatedAt: "2026-07-17T00:00:00.000Z",
          },
        }}
        onClose={mock(() => undefined)}
        onStatusChange={mock(() => true)}
        onDelete={mock(() => true)}
        onDispatch={mock(() => true)}
        onScheduleSave={mock(() => Promise.resolve(makeCard("todo")))}
        onCancelSchedule={mock(() => Promise.resolve(makeCard("todo")))}
      />,
    );

    expect(html).toContain("START NOW");
    expect(html).toContain("Scheduled Dispatch");
    expect(html).toContain("2026-07-18 09:30 KST");
    expect(html).toContain("Start Now는 이 예약을 소비하고 즉시 한 번만 실행합니다.");
  });

  test("shows Script execution metadata and Quick Action provenance", () => {
    const html = renderDialog({
      ...makeCard("complete"),
      originChannel: 'quick_action',
      executionKind: 'script',
      quickActionId: 'qa-deploy',
      scriptRunId: 'run-deploy',
      scriptName: 'Deploy service',
      agentRuntime: 'opencode',
      agentType: 'sisyphus',
      model: 'legacy-model',
      resolution: 'failed',
      durationMs: 1250,
      result: '[failed] Script execution failed.',
    });

    expect(html).toContain('Quick Action');
    expect(html).toContain('Execution');
    expect(html).toContain('Deploy service');
    expect(html).toContain('run-deploy');
    expect(html).toContain('failed');
    expect(html).toContain('Result captured');
    expect(html).toContain('>Type</span>');
    expect(html).toContain('>SCRIPT</span>');
    expect(html).toContain('Script execution · Deploy service');
    expect(html).not.toContain('OPENCODE');
    expect(html).not.toContain('>Runtime</span>');
    expect(html).not.toContain('kv2-meta-card--agent');
    expect(html).not.toContain('kv2-meta-card--model');
    expect(html.match(/>SCRIPT<\/span>/g)).toHaveLength(1);
  });

  test("hides editable runtime, model, agent, and runtime options for Script cards", () => {
    const html = renderToStaticMarkup(
      <CardDetailDialog
        card={{
          ...makeCard("todo"),
          executionKind: 'script',
          scriptName: 'Deploy service',
          agentRuntime: 'codex',
          agentType: 'sisyphus',
          model: 'gpt-5.6-sol',
          codexOptions: {
            reasoningEffort: 'high',
            sandbox: 'workspace-write',
            skipGitRepoCheck: true,
            bypassApprovalsAndSandbox: false,
          },
        }}
        onClose={mock(() => undefined)}
        onStatusChange={mock(() => true)}
        onDelete={mock(() => true)}
        onUpdate={mock(() => undefined)}
      />,
    );

    expect(html).toContain('>Type</span>');
    expect(html).toContain('>SCRIPT</span>');
    expect(html).not.toContain('CODEX');
    expect(html).not.toContain('kv2-runtime-trigger');
    expect(html).not.toContain('kv2-meta-card--agent');
    expect(html).not.toContain('kv2-meta-card--model');
    expect(html).not.toContain('kv2-meta-card--codex-options');
    expect(html).not.toContain('>Reasoning</span>');
    expect(html).not.toContain('>Sandbox</span>');
  });
});
