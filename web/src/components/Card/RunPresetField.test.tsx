import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunPresetField, presetTitle, type PresetRuntimeEntry } from "./RunPresetField";
import type { RunPreset } from "./runPresets";

const runtimes: PresetRuntimeEntry[] = [
  { runtime: "claude", label: "Claude", models: [
    { id: "claude-opus-5-5", label: "Opus 5.5 (1M context)", tier: "opus" },
    { id: "claude-opus-4-8", label: "Opus 4.8", tier: "opus" },
  ] },
  { runtime: "codex", label: "Codex", models: [{ id: "gpt-5.5", label: "GPT-5.5", tier: "general" }] },
];
const defaults = { claudePermission: "plan" as const, claudeEffort: "auto" as const, codexSandbox: "workspace-write" as const, codexEffort: "medium" as const };
const opus: RunPreset = { runtime: "claude", model: "claude-opus-4-8", permission: "plan", effort: "high" };
const codex: RunPreset = { runtime: "codex", model: "gpt-5.5", permission: "workspace-write", effort: "high" };

function render(value: RunPreset, presets: RunPreset[]) {
  return renderToStaticMarkup(
    <RunPresetField value={value} onChange={() => {}} runtimes={runtimes} presets={presets} onPresetsChange={() => {}} defaults={defaults} />,
  );
}

describe("RunPresetField", () => {
  test("header holds 모든 모델 left of 편집 — no separate selection row", () => {
    const html = render(opus, [opus, codex]);
    expect(html.indexOf("모든 모델 ▾")).toBeLessThan(html.indexOf(">편집<"));
    expect(html).toContain('aria-label="즐겨찾기 2/6"');
  });

  test("the matching favorite is the checked radio; 4 empty slots fill the 3×2 grid", () => {
    const html = render(opus, [opus, codex]);
    expect(html.match(/role="radio" aria-checked="true"/g)).toHaveLength(1);
    expect(html).toContain("plan · high");
    expect(html).toContain("WS · high");
    expect(html.match(/kv2-run-preset-slot/g)).toHaveLength(4);
    expect(html).not.toContain("kv2-run-preset-temp");
  });

  test("a selection that is not a favorite shows the 임시 ☆ pill in the header", () => {
    const html = render({ ...opus, effort: "max" }, [opus]);
    expect(html).toContain("kv2-run-preset-temp");
    expect(html).toContain(">현재 선택<");
    expect(html).toContain("☆ 저장");
    expect(html).not.toContain("임시");
    expect(html).toContain("Claude · Opus 4.8 · plan · max");
    expect(html).not.toContain('aria-checked="true"');
  });

  test("first use: all six slots empty, the first one points at 편집", () => {
    const html = render(opus, []);
    expect(html.match(/kv2-run-preset-slot/g)).toHaveLength(6);
    expect(html).toContain("편집에서 즐겨찾기 추가");
  });

  test("presetTitle spells out runtime, model (+1M tag) and options", () => {
    expect(presetTitle(runtimes, { runtime: "claude", model: "claude-opus-5-5", permission: "acceptEdits", effort: "xhigh" }))
      .toBe("Claude · Opus 5.5 1M · edits · xhigh");
    expect(presetTitle(runtimes, { ...codex, model: "gpt-unknown" })).toBe("Codex · gpt-unknown · WS · high");
  });
});
