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
        onScheduleOpen={mock(() => undefined)}
        onCancelSchedule={mock(() => Promise.resolve(makeCard("todo")))}
      />,
    );

    expect(html).toContain("START NOW");
    expect(html).toContain("Scheduled Dispatch");
    expect(html).toContain("2026-07-18 09:30 KST");
    expect(html).toContain("Start Now는 이 예약을 소비하고 즉시 한 번만 실행합니다.");
  });
});
