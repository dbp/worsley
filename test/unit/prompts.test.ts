import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewRequest, reviewTitle, tourStepRequest } from "../../src/core/prompts";
import type { TourKind, TourPlan } from "../../src/core/tools";

describe("a tour step", () => {
  const plan = (kind: TourKind): TourPlan => ({
    title: "The shop",
    kind,
    steps: [{ path: "src/shop/cart.py", start: 1, end: 9, title: "The cart", summary: "The type every other module takes." }],
  });

  it("of a tour of structure asks what the code separates and connects, not how it works", () => {
    const request = tourStepRequest(plan("structure"), 0, "1: class Cart:");
    assert.match(request, /what it separates or connects, what depends on it/);
    assert.match(request, /Leave out how the code works line by line/);
    assert.match(request, /Your plan for this step: The type every other module takes\./);
  });

  it("of a walkthrough asks what the code does", () => {
    const request = tourStepRequest(plan("walkthrough"), 0, "1: class Cart:");
    assert.match(request, /Explain this step: what the code does/);
    assert.doesNotMatch(request, /separates or connects/);
  });
});

describe("a review of the user's changes", () => {
  it("shows a short request and sends the diff with it", () => {
    assert.equal(reviewTitle("src/cart.js"), "Review my uncommitted changes to src/cart.js.");
    assert.equal(reviewTitle(undefined), "Review my uncommitted changes.");
    const request = reviewRequest("src/cart.js", "diff --git a/src/cart.js b/src/cart.js\n+x\n");
    assert.match(request, /^Review my uncommitted changes to src\/cart\.js\. I made them by hand/);
    assert.match(request, /call for changes elsewhere/);
    assert.match(request, /<diff>\ndiff --git a\/src\/cart\.js b\/src\/cart\.js\n\+x\n<\/diff>$/);
  });

  it("cuts a long diff at a line, and says how much is left out", () => {
    const line = `+${"x".repeat(98)}\n`;
    const request = reviewRequest(undefined, line.repeat(1000));
    assert.match(request, /\n<\/diff>\n\(The diff goes on for another 400 lines, left out here: read the files for the rest\.\)$/);
    assert.ok(request.length < 62_000);
  });
});
