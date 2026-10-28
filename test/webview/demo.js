// Plays a thread into the panel, standing in for the extension. Choose it
// with ?scene=ask|change|tour|empty, and ?theme=light for the light theme.
"use strict";

(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("theme") === "light") {
    document.documentElement.classList.add("light");
  }
  const scene = params.get("scene") ?? "ask";
  const files = ["src/shop/cart.py", "src/shop/pricing.py", "src/shop/cli.py", "tests/test_cart.py", "README.md"];
  const post = (message) => window.postMessage(message, "*");
  const sent = [];
  window.worsleySent = sent;

  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      sent.push(message);
      if (message.type === "ready") {
        setTimeout(play, 0);
      } else if (message.type === "checkLinks") {
        const statuses = {};
        for (const href of message.hrefs) {
          const file = href.replace(/[#:].*$/, "");
          statuses[href] = files.some((f) => f === file || f.endsWith(`/${file}`)) ? "ok" : "missing";
        }
        post({ type: "links", id: message.id, statuses });
      }
    },
  });

  const chips = [
    { key: "sel:src/shop/cart.py:18-27", kind: "selection", label: "cart.py:18-27", detail: "Selected: src/shop/cart.py, lines 18-27", excluded: false },
    { key: "file:src/shop/cart.py", kind: "file", label: "cart.py", detail: "Active editor: src/shop/cart.py, all 64 lines", excluded: false },
    { key: "file:tests/test_cart.py", kind: "file", label: "test_cart.py", detail: "Visible: tests/test_cart.py, all 41 lines", excluded: true },
  ];

  const ask = [
    { kind: "user", id: "i1", mode: "ask", text: "Why does this apply the discount before tax rather than after?", context: ["cart.py:18-27", "cart.py"] },
    { kind: "tool", id: "i2", icon: "search", summary: "Searched for “discount”: 9 matches in 3 files", detail: "src/shop/cart.py:21: subtotal = apply_discount(subtotal, self.code)\nsrc/shop/pricing.py:8: def apply_discount(amount, code):\ntests/test_cart.py:30: def test_discount_before_tax():", status: "done" },
    { kind: "tool", id: "i3", icon: "read", summary: "Read src/shop/pricing.py:1–40", href: "src/shop/pricing.py#L1-L40", status: "done" },
    { kind: "tool", id: "i4", icon: "references", summary: "Found 4 references to apply_discount", detail: "src/shop/cart.py:21: subtotal = apply_discount(subtotal, self.code)\nsrc/shop/cli.py:44: print(apply_discount(total, args.code))", status: "done" },
    {
      kind: "locations",
      id: "i5",
      title: "Where the discount and tax are applied",
      locations: [
        { href: "src/shop/cart.py#L21-L23", label: "src/shop/cart.py:21–23", note: "discount, then tax, on the subtotal", preview: "subtotal = apply_discount(subtotal, self.code)\ntaxed = subtotal * (1 + TAX_RATE)" },
        { href: "src/shop/pricing.py#L8-L19", label: "src/shop/pricing.py:8–19", note: "apply_discount: percentage or fixed codes", preview: "def apply_discount(amount, code):\n    rule = DISCOUNTS.get(code)" },
        { href: "tests/test_cart.py#L30-L36", label: "tests/test_cart.py:30–36", note: "the test that pins the order down", preview: "def test_discount_before_tax():" },
      ],
    },
    {
      kind: "assistant",
      id: "i6",
      reasoning: "",
      streaming: false,
      text:
        "Because the tax is owed on what the customer actually pays. [`Cart.total`](src/shop/cart.py#L18-L27) takes the discount off the subtotal at [line 21](src/shop/cart.py#L21) and only then adds tax at line 23, so a 10% code also lowers the tax.\n\n" +
        "Doing it the other way round would charge tax on money the customer never pays. The order is pinned down by `tests/test_cart.py:30`, which expects `£9.90` for a £10 item with `SAVE10` and 10% tax.\n\n" +
        "`apply_discount` itself (in `pricing.py`) doesn't know about tax at all; an old `src/shop/tax.py` is gone.",
      stats: "14.2s · 4 rounds · 9.8K context · 412 generated · 29.6 tok/s",
    },
  ];

  const change = [
    { kind: "user", id: "c1", mode: "change", text: "Let a discount code be a fixed amount off as well as a percentage.", context: ["pricing.py:8-19", "pricing.py"] },
    { kind: "notice", id: "c2", level: "info", text: "2 files already had uncommitted changes, so git will show Worsley's changes mixed in with them." },
    { kind: "assistant", id: "c3", text: "", reasoning: "The DISCOUNTS table maps codes to percentages. I need a second kind of rule, and every caller of apply_discount has to keep working…", streaming: false },
    { kind: "tool", id: "c4", icon: "references", summary: "Found 4 references to apply_discount", status: "done", detail: "src/shop/cart.py:21\nsrc/shop/cli.py:44" },
    { kind: "tool", id: "c5", icon: "edit", summary: "Edited src/shop/pricing.py:8–24", href: "src/shop/pricing.py#L8-L24", diffPath: "src/shop/pricing.py", status: "done" },
    { kind: "tool", id: "c6", icon: "edit", summary: "Edited tests/test_cart.py:38–47", href: "tests/test_cart.py#L38-L47", diffPath: "tests/test_cart.py", status: "done" },
    { kind: "tool", id: "c7", icon: "run", summary: "Ran pytest -q: exit 1, 1.9s", detail: "..F.\n=================================== FAILURES ===================================\n___________________________ test_fixed_discount ___________________________\n    assert cart.total() == 8.80\nE   assert 8.8000001 == 8.8\n1 failed, 3 passed in 0.31s", status: "failed" },
    { kind: "tool", id: "c8", icon: "edit", summary: "Edited src/shop/pricing.py:20", href: "src/shop/pricing.py#L20", diffPath: "src/shop/pricing.py", status: "done" },
    { kind: "tool", id: "c9", icon: "run", summary: "Ran pytest -q: exit 0, 1.7s", detail: "....\n4 passed in 0.29s", status: "done" },
    { kind: "approval", id: "c10", command: "python -m mypy src", status: "pending", scopes: ["python -m mypy …", "python -m mypy src …", "exactly this command"], scope: 0 },
  ];

  const changeDone = [
    { kind: "approval", id: "c10", command: "python -m mypy src", status: "approved", scopes: ["python -m mypy …", "python -m mypy src …", "exactly this command"], scope: 0, allowed: "python -m mypy …" },
    { kind: "tool", id: "c11", icon: "run", summary: "Ran python -m mypy src: exit 0, 3.2s", detail: "Success: no issues found in 4 source files", status: "done" },
    {
      kind: "assistant",
      id: "c12",
      reasoning: "",
      streaming: false,
      text:
        "A code can now take a fixed amount off. [`apply_discount`](src/shop/pricing.py#L8-L24) reads the rule's `kind` and rounds to pence at [line 20](src/shop/pricing.py#L20), which the first test run showed was needed.\n\n" +
        "- [`DISCOUNTS`](src/shop/pricing.py#L3-L6) gains `TAKE2` (£2 off).\n- [`test_fixed_discount`](tests/test_cart.py#L38-L47) is new.\n\nThe four tests pass, and mypy is happy.",
      stats: "1m 12s · 9 rounds · 18K context · 1.3K generated · 28.1 tok/s",
    },
    { kind: "changes", id: "c13", files: [{ path: "src/shop/pricing.py", created: false }, { path: "tests/test_cart.py", created: false }] },
  ];

  const tour = {
    title: "How the shop works",
    current: 1,
    steps: [
      { title: "The command line", href: "src/shop/cli.py#L1-L30", itemId: "t2" },
      { title: "Carts and items", href: "src/shop/cart.py#L1-L27", itemId: "t4" },
      { title: "Pricing rules", href: "src/shop/pricing.py#L1-L24" },
      { title: "The tests", href: "tests/test_cart.py#L1-L47" },
    ],
  };
  const tourItems = [
    { kind: "user", id: "t0", mode: "ask", text: "Give me a tour of this codebase: what it is for, how it is organized, and how its main parts work together.", context: [] },
    { kind: "assistant", id: "t1", text: "Four stops, from the command you run to the tests that pin it down.", reasoning: "", streaming: false },
    { kind: "step", id: "t2", index: 0, total: 4, title: "The command line", href: "src/shop/cli.py#L1-L30" },
    { kind: "assistant", id: "t3", text: "Everything starts in [`main`](src/shop/cli.py#L12-L30): it parses the arguments with `argparse`, builds a `Cart` from the items given, and prints `cart.total()`.\n\nNothing here knows about prices; that is the cart's job.", reasoning: "", streaming: false },
    { kind: "step", id: "t4", index: 1, total: 4, title: "Carts and items", href: "src/shop/cart.py#L1-L27" },
    { kind: "assistant", id: "t5", text: "An [`Item`](src/shop/cart.py#L6-L9) is a name and a price; a [`Cart`](src/shop/cart.py#L12-L27) is a list of them and an optional discount code. `total` is where the steps from `cli.py` end up", reasoning: "", streaming: true },
  ];

  function play() {
    post({ type: "backend", label: "Qwen3.6-35B-A3B-Q4_K_M · local", tooltip: "http://127.0.0.1:8080/v1" });
    if (scene === "empty") {
      post({ type: "reset", items: [], tour: undefined, busy: false, status: "" });
      post({ type: "context", chips: chips.slice(1, 2) });
      return;
    }
    if (scene === "tour") {
      post({ type: "reset", items: tourItems, tour, busy: true, status: "Writing…" });
      post({ type: "context", chips: [{ key: "file:src/shop/cart.py", kind: "file", label: "cart.py", detail: "Active editor", excluded: false }] });
      return;
    }
    if (scene === "change") {
      post({ type: "reset", items: change, tour: undefined, busy: true, status: "Waiting for you to approve a command…" });
      post({ type: "context", chips: chips.slice(1) });
      if (params.has("done")) {
        for (const item of changeDone) {
          post({ type: "item", item });
        }
        post({ type: "busy", busy: false, status: "" });
      }
      return;
    }
    post({ type: "reset", items: ask, tour: undefined, busy: false, status: "" });
    post({ type: "context", chips });
  }
})();
