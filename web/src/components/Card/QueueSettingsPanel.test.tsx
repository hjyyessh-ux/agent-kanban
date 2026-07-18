import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KanbanCard } from "../../../../src/core/types";
import { QueueSettingsPanel } from "./QueueSettingsPanel";

function makeCard(overrides: Partial<KanbanCard>): KanbanCard {
  return {
    id: "card-1",
    title: "Card title",
    description: "Prompt body",
    status: "todo",
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("QueueSettingsPanel", () => {
  test("uses the custom queue target picker instead of a native select", () => {
    const html = renderToStaticMarkup(
      <QueueSettingsPanel
        card={makeCard({ id: "source", title: "Source card" })}
        allCards={[
          makeCard({ id: "source", title: "Source card" }),
          makeCard({ id: "target", title: "Target card", status: "in_progress" }),
        ]}
        queueModeSummary={{ title: "Start a new session", description: "" }}
        queueTargetId=""
        queueSessionMode="new_session"
        onQueueTargetChange={mock(() => undefined)}
        onQueueSessionModeChange={mock(() => undefined)}
        onQueue={mock(() => undefined)}
        defaultExpanded
      />,
    );

    expect(html).toContain("kv2-queue-target-picker");
    expect(html).toContain('id="detail-queue-select"');
    expect(html).toContain("Start independently");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<option");
  });

  test("shows session mode controls after selecting a queue target", () => {
    const html = renderToStaticMarkup(
      <QueueSettingsPanel
        card={makeCard({ id: "source", title: "Source card" })}
        allCards={[
          makeCard({ id: "source", title: "Source card" }),
          makeCard({ id: "target", title: "Target card", status: "in_progress" }),
        ]}
        queueModeSummary={{ title: "Continue previous card session", description: "" }}
        queueTargetId="target"
        queueSessionMode="continue_queued_after_session"
        onQueueTargetChange={mock(() => undefined)}
        onQueueSessionModeChange={mock(() => undefined)}
        onQueue={mock(() => undefined)}
        defaultExpanded
      />,
    );

    expect(html).toContain("Target card");
    expect(html).toContain("New Session");
    expect(html).toContain("Continue After Session");
    expect(html).toContain("SAVE QUEUE SETTINGS");
    expect(html).toContain('checked=""');
  });

  test("shows a schedule conflict message when queueing is blocked by a reservation", () => {
    const html = renderToStaticMarkup(
      <QueueSettingsPanel
        card={makeCard({ id: "source", title: "Source card" })}
        allCards={[
          makeCard({ id: "source", title: "Source card" }),
          makeCard({ id: "target", title: "Target card", status: "in_progress" }),
        ]}
        queueModeSummary={{ title: "Continue previous card session", description: "" }}
        queueTargetId="target"
        queueSessionMode="continue_queued_after_session"
        disabledReason="예약된 카드는 먼저 예약을 취소해야 Queue에 넣을 수 있습니다."
        onQueueTargetChange={mock(() => undefined)}
        onQueueSessionModeChange={mock(() => undefined)}
        onQueue={mock(() => undefined)}
        defaultExpanded
      />,
    );

    expect(html).toContain("예약된 카드는 먼저 예약을 취소해야 Queue에 넣을 수 있습니다.");
    expect(html).not.toContain("SAVE QUEUE SETTINGS");
  });
});
