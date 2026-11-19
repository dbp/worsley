// Plays a thread into the panel, standing in for the extension. Choose it
// with ?scene=ask|change|uncommitted|tour|syntax|functions|changes|empty,
// ?theme=light for the light theme, and ?level=1|2|3|N for the panel at that
// level: 1 (the syntax scene's default) offers only Explain line and
// Translate, 2 (the functions scene's) Check function and Fill in function
// besides, 3 (the changes scene's) Review my changes besides, and N
// everything.
"use strict";

(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("theme") === "light") {
    document.documentElement.classList.add("light");
  }
  const scene = params.get("scene") ?? "ask";
  const defaults = { syntax: "1", functions: "2", changes: "3" };
  const level = params.get("level") ?? defaults[scene] ?? "N";
  // As core/levels.ts has them.
  const levels = [
    { level: 1, name: "Syntax", features: ["explain", "translate"] },
    { level: 2, name: "Functions", features: ["check", "fill"] },
    { level: 3, name: "Changes", features: ["reviewFile"] },
    { level: "N", name: "Everything", features: ["ask", "change", "tour", "reviewAll"] },
  ];
  const sections = level === "N" ? levels : levels.slice(0, Number(level));
  const features = sections.flatMap((section) => section.features);
  const files = ["src/shop/cart.py", "src/shop/pricing.py", "src/shop/cli.py", "tests/test_cart.py", "README.md", "shipping.py", "test_shipping.py", "stats.py", "test_stats.py"];
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

  const uncommitted = {
    kind: "uncommitted",
    id: "c0",
    files: [
      { path: "src/shop/cart.py", untracked: false, lines: { added: 3, removed: 1 } },
      { path: "src/shop/logo.png", untracked: false },
      { path: "notes/discounts.md", untracked: true, lines: { added: 12, removed: 0 } },
    ],
    unsaved: ["src/shop/pricing.py"],
    status: "pending",
  };

  const change = [
    { ...uncommitted, status: "sent" },
    { kind: "user", id: "c1", mode: "change", text: "Let a discount code be a fixed amount off as well as a percentage.", context: ["pricing.py:8-19", "pricing.py"] },
    { kind: "notice", id: "c2", level: "info", text: "Saved 1 file with unsaved changes first, so that the tests run on what you see." },
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
    title: "How the shop is built",
    current: 1,
    steps: [
      { title: "Where the parts meet", href: "src/shop/cli.py#L1-L30", itemId: "t2" },
      { title: "Cart, the shared type", href: "src/shop/cart.py#L1-L27", itemId: "t4" },
      { title: "Pricing behind one function", href: "src/shop/pricing.py#L1-L24" },
      { title: "The tests that hold that line", href: "tests/test_cart.py#L1-L47" },
    ],
  };
  const tourItems = [
    { kind: "user", id: "t0", mode: "ask", text: "Give me a tour of how this codebase is structured: its components, what separates and connects them, and how tightly they are coupled.", context: [] },
    { kind: "assistant", id: "t1", text: "Four stops: where the parts are put together, the type they share, the one function pricing hides behind, and the tests that hold that line.", reasoning: "", streaming: false },
    { kind: "step", id: "t2", index: 0, total: 4, title: "Where the parts meet", href: "src/shop/cli.py#L1-L30" },
    { kind: "assistant", id: "t3", text: "[`main`](src/shop/cli.py#L12-L30) is the only code that knows about every part: it builds a `Cart` and prints its total. Dependencies point one way, `cli` to `cart` to `pricing`, and nothing imports `cli`.\n\nSo the command line could be swapped for another front end without touching the rest.", reasoning: "", streaming: false },
    { kind: "step", id: "t4", index: 1, total: 4, title: "Cart, the shared type", href: "src/shop/cart.py#L1-L27" },
    { kind: "assistant", id: "t5", text: "[`Cart`](src/shop/cart.py#L12-L27) is the type the other modules pass around, but pricing never sees it: [`total`](src/shop/cart.py#L18-L27) hands `apply_discount` only an amount and a code, so", reasoning: "", streaming: true },
  ];

  const syntax = [
    { kind: "user", id: "s1", mode: "explain", text: "squares = [n ** 2 for n in numbers if n % 2 == 0]", context: ["stats.py:12"] },
    {
      kind: "assistant",
      id: "s2",
      reasoning: "",
      streaming: false,
      text:
        "This line builds a new list with a **list comprehension**.\n\n" +
        "- `squares =` gives the name `squares` to what is on the right.\n" +
        "- `[ … ]`: the square brackets make a list.\n" +
        "- `n ** 2` is what goes into the list for each item: `n` to the power of 2.\n" +
        "- `for n in numbers` goes through `numbers` one item at a time, calling each one `n`.\n" +
        "- `if n % 2 == 0` keeps only the items whose remainder after dividing by 2 is 0: the even ones.\n\n" +
        "So `squares` becomes a list of the squares of the even numbers in `numbers`.",
      stats: "4.1s · 214 generated · 61.2 tok/s",
    },
    {
      kind: "user",
      id: "s3",
      mode: "translate",
      text: "define a function average that takes numbers\n    set total to 0\n    for each n in numbers\n        add n to total\n    handle the case where numbers is empty\n    return total divided by length of numbers",
      context: ["stats.py:20-25"],
    },
    {
      kind: "assistant",
      id: "s4",
      reasoning: "",
      streaming: false,
      text:
        "```python\ndef average(numbers):\n    total = 0\n    for n in numbers:\n        total += n\n    handle the case where numbers is empty\n    return total / len(numbers)\n```\n" +
        "- \"handle the case where numbers is empty\": this says what to achieve, not the steps. Say what to do when there are no numbers.",
      stats: "2.9s · 73 generated · 58.0 tok/s",
    },
    { kind: "notice", id: "s5", level: "info", text: "Put the translation in stats.py, at lines 20-25, in place of your lines. Undo in the editor brings them back." },
  ];

  const functions = [
    { kind: "user", id: "f1", mode: "check", text: "def shipping_cost(weight):", context: ["shipping.py:4-8", "test_shipping.py:3-5"] },
    {
      kind: "assistant",
      id: "f2",
      reasoning: "",
      streaming: false,
      text:
        "**They don't fit.**\n\n" +
        "The docstring promises 2 per kilogram, but [a parcel over 20 kg costs a flat 50](shipping.py#L6-L7), which neither it nor [the tests](test_shipping.py#L3-L5) mention: they try 3 kg and 10 kg only.",
      stats: "2.3s · 118 generated · 64.0 tok/s",
    },
    { kind: "user", id: "f3", mode: "fill", text: "def average(numbers):", context: ["stats.py:1-3", "test_stats.py:4-5"] },
    {
      kind: "assistant",
      id: "f4",
      reasoning: "",
      streaming: false,
      text: '```python\ndef average(numbers):\n    """Return the mean of numbers."""\n    return sum(numbers) / len(numbers)\n```\nNothing says what an empty list gives: as written, it raises `ZeroDivisionError`.',
      stats: "1.4s · 52 generated · 61.5 tok/s",
    },
    { kind: "notice", id: "f5", level: "info", text: "Filled in average in stats.py, at lines 1-3. Undo in the editor brings back what was there." },
  ];

  const changes = [
    { kind: "user", id: "r1", mode: "ask", text: "Review my uncommitted changes to src/shop/pricing.py.", context: ["pricing.py"] },
    { kind: "tool", id: "r2", icon: "references", summary: "Found 3 references to apply_discount", detail: "src/shop/cart.py:21: subtotal = apply_discount(subtotal, self.code)\nsrc/shop/cli.py:44: print(apply_discount(total, args.code))\ntests/test_cart.py:30: assert apply_discount(10, 'SAVE10') == 9", status: "done" },
    {
      kind: "locations",
      id: "r3",
      title: "What still calls apply_discount with one code",
      locations: [
        { href: "src/shop/cart.py#L21", label: "src/shop/cart.py:21", note: "passes self.code, a single code", preview: "subtotal = apply_discount(subtotal, self.code)" },
        { href: "src/shop/cli.py#L44", label: "src/shop/cli.py:44", note: "passes args.code", preview: "print(apply_discount(total, args.code))" },
        { href: "tests/test_cart.py#L30", label: "tests/test_cart.py:30", note: "tests the old form", preview: "assert apply_discount(10, 'SAVE10') == 9" },
      ],
    },
    {
      kind: "assistant",
      id: "r4",
      reasoning: "",
      streaming: false,
      text: "[`apply_discount`](src/shop/pricing.py#L8-L19) now takes a list of codes, but its three callers still pass one code each, so `cart.py` will loop over the letters of `SAVE10`. The docstring still says *code*, too.",
      stats: "9.6s · 4 rounds · 6.1K context · 188 generated",
    },
  ];

  function play() {
    post({ type: "level", level: level === "N" ? "N" : Number(level), features, sections });
    if (scene === "functions") {
      post({ type: "backend", label: "deepseek/deepseek-v4.1-flash-1017 · openrouter", tooltip: "https://openrouter.ai/api/v1" });
      post({ type: "reset", items: functions, tour: undefined, busy: false, status: "" });
      return;
    }
    if (scene === "changes") {
      post({ type: "backend", label: "deepseek/deepseek-v4.1-flash-1017 · openrouter", tooltip: "https://openrouter.ai/api/v1" });
      post({ type: "reset", items: changes, tour: undefined, busy: false, status: "" });
      return;
    }
    post({ type: "backend", label: "Qwen3.6-35B-A3B-Q4_K_M · local", tooltip: "http://127.0.0.1:8080/v1" });
    if (scene === "empty") {
      post({ type: "reset", items: [], tour: undefined, busy: false, status: "" });
      post({ type: "context", chips: chips.slice(1, 2) });
      return;
    }
    if (scene === "syntax") {
      post({ type: "reset", items: syntax, tour: undefined, busy: false, status: "" });
      post({ type: "context", chips: chips.slice(1, 2) });
      return;
    }
    if (scene === "tour") {
      post({ type: "reset", items: tourItems, tour, busy: true, status: "Writing…" });
      post({ type: "context", chips: [{ key: "file:src/shop/cart.py", kind: "file", label: "cart.py", detail: "Active editor", excluded: false }] });
      return;
    }
    if (scene === "uncommitted") {
      post({ type: "reset", items: [...ask, uncommitted], tour: undefined, busy: true, status: "Waiting for you to confirm…" });
      post({ type: "context", chips: chips.slice(1) });
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
