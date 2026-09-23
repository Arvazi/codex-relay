import { describe, expect, it } from "vitest";

import type { CodexModel } from "../src/api-schema.js";
import {
  modelPickerSheetPresentation,
  modelButtonLabel,
  modelForSelection,
  normalizeRuntimePreferencesForModels,
  powerSelectionAccessibilityLabel,
  powerSelectionLabel,
  powerSelectionsForModels,
  reasoningDisplayOptions,
  reasoningEffortForModel,
  reasoningTitle,
  speedDisplayOptions,
} from "../../../apps/mobile/src/components/chat/model-picker-options.js";

const models: CodexModel[] = [
  model({
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    defaultReasoningEffort: "low",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  }),
  model({
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    defaultReasoningEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  }),
  model({
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6-Luna",
    defaultReasoningEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
];

describe("mobile model picker options", () => {
  it("keeps compact Power and the Advanced root content-fit", () => {
    expect(modelPickerSheetPresentation(false)).toEqual({
      enableDynamicSizing: true,
      expandedSnapPercent: undefined,
      initialSnapIndex: 0,
      scrollable: false,
      showBackButton: false,
    });
    expect(modelPickerSheetPresentation(true)).toEqual({
      enableDynamicSizing: true,
      expandedSnapPercent: 94,
      initialSnapIndex: 0,
      scrollable: true,
      showBackButton: false,
    });
  });

  it("returns to compact Power from Advanced", () => {
    expect(modelPickerSheetPresentation(true, true)).toMatchObject({
      showBackButton: true,
    });
    expect(modelPickerSheetPresentation(true, false)).toMatchObject({
      showBackButton: false,
    });
    expect(modelPickerSheetPresentation(false, true)).toMatchObject({
      showBackButton: false,
    });
  });

  it("builds Power from the catalog default model in source order", () => {
    const futureModel = model({
      id: "future-model",
      displayName: "Future Model",
      defaultReasoningEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra", "future"],
    });
    const selections = powerSelectionsForModels([futureModel, ...models]);

    expect(selections).toEqual([
      {
        id: "gpt-5.6-sol:low",
        model: "gpt-5.6-sol",
        modelLabel: "GPT-5.6-Sol",
        powerSettingIndex: 0,
        reasoningEffort: "low",
      },
      {
        id: "gpt-5.6-sol:medium",
        model: "gpt-5.6-sol",
        modelLabel: "GPT-5.6-Sol",
        powerSettingIndex: 1,
        reasoningEffort: "medium",
      },
      {
        id: "gpt-5.6-sol:high",
        model: "gpt-5.6-sol",
        modelLabel: "GPT-5.6-Sol",
        powerSettingIndex: 2,
        reasoningEffort: "high",
      },
      {
        id: "gpt-5.6-sol:xhigh",
        model: "gpt-5.6-sol",
        modelLabel: "GPT-5.6-Sol",
        powerSettingIndex: 3,
        reasoningEffort: "xhigh",
      },
      {
        id: "gpt-5.6-sol:max",
        model: "gpt-5.6-sol",
        modelLabel: "GPT-5.6-Sol",
        powerSettingIndex: 4,
        reasoningEffort: "max",
      },
      {
        id: "gpt-5.6-sol:ultra",
        model: "gpt-5.6-sol",
        modelLabel: "GPT-5.6-Sol",
        powerSettingIndex: 5,
        reasoningEffort: "ultra",
      },
    ]);
    expect(selections.map(powerSelectionLabel)).toEqual([
      "Low",
      "Medium",
      "High",
      "Extra High",
      "Max",
      "Ultra",
    ]);
    expect(selections.map(powerSelectionAccessibilityLabel)).toEqual([
      "GPT-5.6-Sol Low",
      "GPT-5.6-Sol Medium",
      "GPT-5.6-Sol High",
      "GPT-5.6-Sol Extra High",
      "GPT-5.6-Sol Max",
      "GPT-5.6-Sol Ultra",
    ]);
  });

  it("shows every source-provided effort in Advanced", () => {
    expect(reasoningDisplayOptions(models[0])).toEqual([
      { label: "Low", subtitle: "low description", value: "low" },
      { label: "Medium", subtitle: "medium description", value: "medium" },
      { label: "High", subtitle: "high description", value: "high" },
      { label: "Extra High", subtitle: "xhigh description", value: "xhigh" },
      { label: "Max", subtitle: "max description", value: "max" },
      { label: "Ultra", subtitle: "Consumes usage limits faster", value: "ultra" },
    ]);
    expect(
      normalizeRuntimePreferencesForModels(models, {
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        runtimeMode: "default",
      }),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
    });
  });

  it("preserves a compatible effort and falls back to the model default otherwise", () => {
    const terra = models[1];
    const luna = models[2];

    expect(reasoningEffortForModel(terra, "high")).toBe("high");
    expect(reasoningEffortForModel(luna, "ultra")).toBe("medium");
  });

  it("shows the exact Advanced speed choices", () => {
    expect(speedDisplayOptions(models[0])).toEqual([
      {
        label: "Standard",
        subtitle: "Standard speed and usage",
        value: undefined,
      },
      {
        label: "Fast",
        subtitle: "1.5x speed, more usage",
        value: "priority",
      },
    ]);
    expect(
      speedDisplayOptions({
        ...models[0],
        serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
      }).at(-1),
    ).toEqual({ label: "Fast", subtitle: "2x speed, increased usage", value: "priority" });
  });

  it("keeps custom model effort and speed controls usable", () => {
    expect(reasoningDisplayOptions(undefined, true).map((option) => option.value)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(speedDisplayOptions(undefined, "priority")).toEqual([
      {
        label: "Standard",
        subtitle: "Standard speed and usage",
        value: undefined,
      },
      {
        label: "Custom",
        subtitle: "Service tier: priority",
        value: "priority",
      },
    ]);
  });

  it("uses warning-only copy for Ultra and preserves custom model labels", () => {
    expect(reasoningDisplayOptions(models[0]).at(-1)).toEqual({
      label: "Ultra",
      subtitle: "Consumes usage limits faster",
      value: "ultra",
    });
    expect(modelButtonLabel(undefined, "high", "custom-model")).toBe("custom-model High");
  });

  it("uses the source title for a stored Max value", () => {
    expect(modelButtonLabel(models[0], "max")).toBe("GPT-5.6-Sol Max");
    expect(reasoningTitle("max")).toBe("Max");
  });

  it("formats opaque reasoning values without prototype-key collisions", () => {
    expect(reasoningTitle("__proto__")).toBe("Proto");
    expect(reasoningTitle("constructor")).toBe("Constructor");
    expect(reasoningTitle("toString")).toBe("ToString");
    expect(reasoningTitle("---")).toBe("---");
    expect(reasoningTitle("___")).toBe("___");
    expect(reasoningTitle("x-high")).toBe("Extra High");
  });

  it("uses the catalog default without masking unknown models", () => {
    expect(modelForSelection(models, undefined)?.model).toBe("gpt-5.6-sol");
    expect(modelForSelection(models, "custom-model")).toBeUndefined();
  });

  it("preserves opaque effort and speed values for known and custom models", () => {
    expect(
      normalizeRuntimePreferencesForModels(models, {
        model: "gpt-5.6-luna",
        reasoningEffort: "beyond-ultra",
        runtimeMode: "default",
        serviceTier: "future-speed",
      }),
    ).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "beyond-ultra",
      serviceTier: "future-speed",
    });
    expect(
      normalizeRuntimePreferencesForModels(models, {
        model: "custom-model",
        reasoningEffort: "ultra",
        runtimeMode: "default",
      }),
    ).toMatchObject({
      model: "custom-model",
      reasoningEffort: "ultra",
    });
  });

  it("materializes the catalog default model when no model is selected", () => {
    const catalog = [models[2], models[1], models[0]];

    expect(
      normalizeRuntimePreferencesForModels(catalog, {
        runtimeMode: "default",
      }),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
    });
  });
});

function model({
  defaultReasoningEffort,
  displayName,
  efforts,
  id,
}: {
  defaultReasoningEffort: CodexModel["defaultReasoningEffort"];
  displayName: string;
  efforts: CodexModel["supportedReasoningEfforts"];
  id: string;
}): CodexModel {
  return {
    id,
    model: id,
    displayName,
    description: `${displayName} description`,
    defaultReasoningEffort,
    isDefault: id === "gpt-5.6-sol",
    reasoningEffortOptions: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} description`,
    })),
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, more usage",
      },
    ],
    supportedReasoningEfforts: efforts,
  };
}
