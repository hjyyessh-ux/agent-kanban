import { describe, expect, test } from "bun:test";
import { deriveCreateLaunchUiState } from "./CreateCardDialog";

describe("deriveCreateLaunchUiState", () => {
  test("uses CREATE for manual creation with no queue target", () => {
    expect(deriveCreateLaunchUiState("later", "")).toEqual({
      primaryActionLabel: "CREATE",
      queueDisabledReason: null,
      scheduleDisabledReason: null,
    });
  });

  test("disables Queue After messaging when schedule mode is selected", () => {
    expect(deriveCreateLaunchUiState("schedule", "")).toEqual({
      primaryActionLabel: "CREATE & SCHEDULE",
      queueDisabledReason: "예약 시작이 설정되어 있어 Queue After를 사용할 수 없습니다. 예약 시작을 끄면 Queue를 설정할 수 있습니다.",
      scheduleDisabledReason: null,
    });
  });

  test("disables schedule mode messaging when a queue target is already selected", () => {
    expect(deriveCreateLaunchUiState("later", "card-123")).toEqual({
      primaryActionLabel: "CREATE",
      queueDisabledReason: null,
      scheduleDisabledReason: "Queue After가 설정되어 있어 예약 시작을 사용할 수 없습니다. queue target을 해제하면 예약할 수 있습니다.",
    });
  });
});
