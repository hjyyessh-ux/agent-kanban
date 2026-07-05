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
});
