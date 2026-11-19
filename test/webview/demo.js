// Plays a thread into the panel, standing in for the extension. Choose it
// with ?scene=ask|change|uncommitted|tour|syntax|empty, ?theme=light for the
// light theme, and ?level=1 for the panel at level 1 (the syntax scene's
// default), where it offers only Explain line and Translate.
"use strict";

(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("theme") === "light") {
    document.documentElement.classList.add("light");
  }
  const scene = params.get("scene") ?? "ask";
  const level = Number(params.get("level") ?? (scene === "syntax" ? 1 : 2));
  const features = level === 1 ? ["explain", "translate"] : ["explain", "translate", "ask", "change", "tour", "review"];
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

  function play() {
    post({ type: "level", level, features });
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
