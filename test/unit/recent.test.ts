import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RECENT_CHOICES, remember, type ModelChoice } from "../../src/core/recent";

describe("the models chosen lately", () => {
  const choice = (backend: string, model: string): ModelChoice => ({ backend, model });

  it("put the latest first, once, and keep the same model on another backend apart", () => {
    let recent: ModelChoice[] = [];
    recent = remember(recent, choice("local", "qwen"));
    recent = remember(recent, choice("openrouter", "deepseek"));
    recent = remember(recent, choice("gpu-box", "qwen"));
    recent = remember(recent, choice("local", "qwen"));
    assert.deepEqual(recent, [choice("local", "qwen"), choice("gpu-box", "qwen"), choice("openrouter", "deepseek")]);
  });

  it(`keep only the latest ${RECENT_CHOICES}`, () => {
    let recent: ModelChoice[] = [];
    for (let i = 1; i <= RECENT_CHOICES + 2; i++) {
      recent = remember(recent, choice("local", `m${i}`));
    }
    assert.equal(recent.length, RECENT_CHOICES);
    assert.deepEqual(recent[0], choice("local", `m${RECENT_CHOICES + 2}`));
    assert.deepEqual(recent.at(-1), choice("local", "m3"));
  });
});
