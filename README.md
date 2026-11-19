# Worsley

An experiment in using a language model to keep people reading code rather
than replacing the reading. Worsley sits in a side panel, sees what the
editor shows, and answers by pointing into the code: every claim links to
the lines it is about, which open and highlight in the editor beside it.
Changes are written straight to the working tree, for review with git;
there is no diff view to accept or reject. Answers stay in the panel rather
than inline in the editor, where there is no room for them, so that an
explanation can range across files and link to each place it is about.

- **Ask about code.** Select some code, press `Ctrl+Alt+A` (`⌘⌥A`) and ask
  your own question. The selection and the visible files go with it.
- **Ask where things are.** "Where do sessions expire?" gives a list of
  every relevant place, each with a note and its first lines; clicking one
  opens it, and *Peek all* shows them in the editor's peek view.
- **Take a tour.** *Tour this codebase* (**Worsley: Tour the Codebase**)
  goes through its structure rather than its details: the components and
  which way they depend on each other, the interfaces and central types that
  separate and connect them, the unit tests that hold those boundaries in
  place, and, last, how modular it really is. A question about how something
  works ("how does a request get handled?") gets a walk through the code
  instead, a function or class at a time. Each step opens in the editor and
  is explained when you reach it, so the explanation can follow on from your
  questions along the way. Questions asked mid-tour get just an answer; the
  tour moves on only when you press *Next*.
- **Change code.** Select code, press `Ctrl+Alt+E` (`⌘⌥E`) and say what to
  change. The model finds what depends on it (with the language server's
  references as well as search), edits it all, updates or adds tests, and
  runs the tests until they pass. The configured test command runs without
  asking; any other command waits for *Run*, *Always allow* or *Don't run*.
  *Always allow* can cover a class of commands rather than one line:
  `cargo test …` for `cargo test` with any arguments, or for
  `grep -rn foo src | head`, both `grep …` and `head …`. **Worsley: Allowed
  Commands…** lists what runs without asking, to take any of it back.
  Nothing is staged or committed. When something already isn't committed,
  the request waits before anything reaches the model: a card lists those
  files, with the lines each has gained and lost, since git would show this
  change mixed in with them. *Send anyway* sends it, and *Cancel* puts your
  message back in the box. Afterwards there is a list of changed files, each
  with its git diff, and *Walk me through it*, which tours the changes.
- **Review your own changes.** The first two buttons at the top of the
  panel ask for a light review of what you have changed by hand and not
  committed: in the file open in the editor, or in the whole workspace. It is
  an Ask, with the `git diff` (new files whole): not about style, but whether
  the changes call for others, such as callers, tests or documentation that
  now disagree, or have implications worth knowing. Edits not yet saved are
  left out, and the panel says which.

The backend is any OpenAI-compatible chat endpoint with tool calls: a local
llama.cpp `llama-server` (the default), OpenRouter, or a server of your own
elsewhere, such as llama.cpp or vLLM on another machine.

## Levels

For a course, Worsley can offer less at first, and more as the course goes
on. `worsley.level` says how much: each level offers what the one below it
does, and more. A course sets it for a workspace, in the
`.vscode/settings.json` of the project its students start from. The menus,
keybindings, command palette and panel show only what the level offers.

- **Level 1** offers two requests that teach how code is written. Each
  stands alone: the model sees only the code it is about, not the rest of
  the file, nor the thread, and has no tools.
  - **Explain a line.** Put the cursor on a line and press `Ctrl+Alt+X`
    (`⌘⌥X`), or *Explain line* in the panel. The line is explained on its
    own, part by part, as its language writes it: on its own, it can't be
    explained by what the program around it is for. Selecting part of the
    line asks about that part.
  - **Translate pseudocode.** Write a program's steps in your own words,
    select them and choose **Translate Into Code**, in the editor's context
    menu or as *Translate* in the panel. They are written in the file's
    language and put in place of what you wrote, which undo in the editor
    brings back. The model is told to add nothing: no step, name, starting
    value, check, conversion or message that isn't in the pseudocode, and a
    mistake in the steps stays a mistake. A line that asks for code ("write
    a function that sorts the list"), or says what to achieve rather than
    how, or leaves out something the code needs ("if the price is too
    high"), is to stay as you wrote it, with the reply saying what it would
    need to be a step. How well a model keeps to this varies, and
    `pnpm run live:translate` measures it (see Layout).
- **Level 2**, the default, offers everything else as well.

## Trying it

```bash
pnpm install
pnpm run build
```

F5 (*Run Extension*) opens a development host on `samples/shop`, a small
Python project whose tests run with `python3 -m unittest`. Or package it and
install it in your own VS Code:

```bash
pnpm run vsce:package
code --install-extension worsley-0.1.0.vsix
```

The `local` backend expects llama.cpp on `http://127.0.0.1:8080/v1`, such as
the router in `~/opt/llama.cpp/router.sh`, and asks for
`Qwen3.6-35B-A3B-Q4_K_M`, thinking only when it changes code. For OpenRouter, run **Worsley:
Set API Key…** (or set `OPENROUTER_API_KEY` before starting VS Code), then
**Worsley: Choose Model…**, which lists the server's models: for llama.cpp,
its presets; for OpenRouter, the models that take tools. It lists first the
last six models you have used, each with its backend, so that going back to
one is a single click; clicking the model's name below the message box, or
in the status bar, opens it too. With OpenRouter the status bar also shows
what the key has spent today, as OpenRouter's `/key` reports it, and its
tooltip the week and month. OpenRouter's day is the UTC day, so it starts
in the evening in America: the tooltip says when.

For a server of your own, choose *Add a server…* in **Worsley: Choose
Model…**: it asks for the address, up to and including `/v1`, and a name,
then lists that server's models. If the server turns Worsley away for want
of a key, Worsley asks for one first, and keeps it in VS Code's secret
storage; a request turned away later offers **Worsley: Set API Key…**. When
the server is down, a request says it couldn't connect, and **Worsley: Choose Model…** switches to another
backend; the thread carries on with whichever model answers next.

## Settings

| Setting | |
| --- | --- |
| `worsley.backends` | The endpoints: `name`, `baseUrl`, `model`, and optionally `apiKeyEnv`, the environment variable holding its key (a backend that names one is used only with a key; any other is sent one only if **Worsley: Set API Key…** has stored it), `headers`, `extraBody`, which is merged into every request, such as `{"chat_template_kwargs": {"enable_thinking": false}}` to turn a Qwen model's thinking off, or `{"provider": {"sort": "throughput"}}` for OpenRouter, and `changeExtraBody`, merged over `extraBody` for Change requests only, such as `{"chat_template_kwargs": {"enable_thinking": true}}` (the `local` default) or OpenRouter's `{"reasoning": {"effort": "medium"}}`, and `contextTokens`, the model's context window, for a server that doesn't report it. User settings only, so a workspace can't send your code elsewhere. |
| `worsley.backend` | Which of them is in use. |
| `worsley.level` | How much of Worsley there is (see Levels): 1, explaining a line and translating pseudocode; 2, everything (the default). |
| `worsley.testCommand` | The workspace's test command, such as `pytest -q`. It runs without asking. Empty: the model works out how the tests run, and each command needs approval. |
| `worsley.commandTimeoutSeconds` | When a command is stopped (600). |
| `worsley.context.maxFileLines` | Visible files up to this long are sent whole (600); longer ones as the lines on screen and 40 either side. |
| `worsley.maxToolRounds` | How many rounds of tool calls one request may take (60). |

Worsley is disabled in untrusted workspaces, since it runs their commands.
Code goes to whichever backend is in use, and nowhere else: the panel loads
nothing remote, not even images in a reply.

## How it works

Explaining a line and translating are each one request, with a system
prompt of their own and a single message: the line and its language, or the
lines with the language and the editor's indentation (without the
indentation the lines share, which the translation gets back). Neither
joins the thread the model sees for Ask and Change, so nothing in that
thread reaches them. A translation goes in only where the code was, if the
file hasn't changed while the model worked; otherwise it is in the panel to
copy. A reply without code, or whose code is what was there already, leaves
the file alone.

Each message is a request in *Ask* or *Change* mode, with an
`<editor_context>` block: the visible files in the workspace folder, which
lines are on screen, and the selections. A file already sent in the thread
and unchanged isn't sent again. The chips above the message box show what
will be sent; clicking one leaves it out.

The model works through tools: `list_files`, `search` (VS Code's own
ripgrep), `read_file`, `outline`, `find_references` and `find_definition`
(the editor's language servers), `show_locations`, `present_tour`,
`edit_file`, `write_file` and `run_command`. The last three are refused in
Ask mode. The system prompt and the tool list stay the same for the whole
thread, whatever each message's mode, so llama.cpp reuses its cached prompt
from turn to turn and only new text is processed; on an iGPU, where prompt
processing runs at a few hundred tokens a second, that is the difference
between seconds and minutes. For the same reason the prompt tells the model
to search and outline before it reads, and to read only the lines it needs.

A thread is kept inside the model's context window. Worsley asks the
server how big the window is (llama.cpp's router and OpenRouter list it in
`/models`, and a single llama.cpp server in `/props`), or takes
`contextTokens`, or learns it from the error when a prompt is refused for
being too long. It estimates each prompt in tokens at the rate the server's
own counts show, and when a prompt would leave the reply too little room
(15% of the window, between 4K and 32K tokens), it makes room. First it
clears old tool results, oldest first, keeping the current request's last
three: file contents, search hits and test output are most of a thread,
and the model can fetch any of them again. Only if the conversation still
doesn't fit does the model summarize the requests before the current one,
which replaces them, in a word budget of half the room the rest of the
prompt leaves (an earlier summary is folded in, so summaries don't grow;
and a summary alone, or anything already shorter than one, isn't summarized
again). When a prompt is refused anyway, room is made the same
way and the turn tried once more. The panel says when it has made room, and
the stats under each reply show how much of the window was in use. Making
room costs a local server its cached prompt from the first change on, so it
clears down to well under the limit, so as not to need to again soon.

The thread outlasts a reload or a restart of VS Code: it is kept in VS
Code's storage for the workspace, after each request and as the window
closes, and **Worsley: New Thread** clears it. A request that a reload cuts
off stops where it got to, as *Stop* would leave it, and "go on" picks it
up.

A Change request can think while the rest don't (`changeExtraBody`):
answers come faster, and a change's deliberation goes into its collapsed
reasoning instead of the reply. Switching costs the cache nothing with
llama.cpp, which keeps earlier replies' reasoning in the prompt by default
(`--reasoning-preserve`), so earlier turns are rendered the same whether or
not the new one thinks. Started with `--no-reasoning-preserve`, it would
render them differently once the next message arrives, and process the
thread again from there.

A command line runs without asking when every simple command in it,
split at `|`, `&&`, `||`, `;` and newlines, starts with words the user has
allowed: so `cargo test 2>&1 | tail -20` runs once `cargo test …` and
`tail …` are allowed, and `cargo test; rm -rf ~` doesn't. A line Worsley
can't see through (command substitution, a subshell, a here-document, a
control structure) is never covered by a class, nor is one that redirects
output into a file, or whose leading words come from variables: those are
allowed only as the exact line. The card suggests a command's class: its
program with the subcommand (`git log …`, `npm run build …`), or what an
interpreter runs (`python3 -m unittest …`). It offers only the exact line
for shells, `sudo`, `xargs` and the like, inline code (`python3 -c`), and
commands that delete, move or reach the network, and it suggests the exact
line, while offering the class, for those that can write files with the
right arguments, such as `sed` and `find`. These choices are kept for each
workspace.

Edits are exact replacements (`old_string` → `new_string`), written to disk
so git sees them and format-on-save doesn't rewrite them behind the model's
back. Before a change, files with unsaved edits are saved, so the tests run
on what you see; the card about uncommitted changes lists them too, since
they become part of what git shows. The card counts lines as `git diff
--numstat` does, against the last commit, and counts a new file's lines
whole. A model's reasoning is kept and sent back as the server sent it
(`reasoning_content` for llama.cpp, `reasoning` and `reasoning_details` for
OpenRouter). An error, and a tool call that failed, has a *Copy* button
that copies its whole text. Links in a reply are checked once it is complete: a link to a
file or folder that doesn't exist is struck through, and paths in code
spans (`cart.py:12`, `src/core/`) and in prose (`cart.py:12`) become links
when they name one. A link to a folder reveals it in the Explorer.

## Layout

- `src/core/`: everything that doesn't need VS Code, tested without it: the
  streaming client (`chat.ts`, `sse.ts`), the agent loop (`agent.ts`), the
  tools (`tools.ts`, with `search.ts`, `edit.ts`, `files.ts`, `shell.ts`,
  `git.ts`), which commands may run without asking (`commandLine.ts`),
  keeping a thread inside the model's window (`compact.ts`) and between
  windows (`saved.ts`), the editor
  context (`context.ts`), links (`links.ts`, shared with the panel), the
  prompts (`prompts.ts`), the levels (`levels.ts`), and level 1's requests
  that stand alone (`standalone.ts`).
- `src/editor/`: the VS Code side: the thread (`session.ts`), the panel's
  host (`panel.ts`), the workspace with its language servers
  (`workspace.ts`), the editor as the context sees it (`editorTracker.ts`),
  highlighting, settings, commands and the status bar.
- `src/webview/`: the panel itself, with markdown-it.
- `media/`: the panel's stylesheet and the sextant, drawn in `worsley.svg`
  for the activity bar. The status bar takes an extension's own icon only
  from a font, so `scripts/icon-font.py` builds `worsley.ttf` from the
  drawing; run it again after changing the drawing.
- `test/unit/`: `node --test` tests of `src/core`, some against a fake
  OpenAI-compatible server (`test/fakeModel.ts`).
- `test/integration/`: VS Code driven against the fake model, in a small
  JavaScript project: an Ask with a selection, the language server's
  references and a list of locations; link checks; a change with two edits
  and the tests; a review of those changes, of one file and of all; a change
  held back by uncommitted ones, cancelled and then sent anyway; a command that needs approval; a two-step tour of the
  structure; the thread kept for the next window; and level 1, where Ask
  and tours are refused, a line is explained, and pseudocode is translated
  in place, undone, and left alone when the file changes meanwhile.
- `test/live/`: one request against a real model from the command line, with
  the same prompts and tools but no language servers (`run.ts`, which can
  send a selection and report times, tokens and broken links as JSON), and
  six such tasks with checks, for comparing models (`suite.ts`). Translate
  is measured on its own (`translations.ts`): pseudocode with traps in it,
  such as a line that asks for code, a step without its value, a mistake to
  keep, or input that mustn't become a number, each translated several
  times. Every translation is checked for names, numbers, strings and
  comments that aren't in the pseudocode (`details.ts`), and for what its
  case expects.
- `test/webview/`: the panel in a browser, with a stand-in for VS Code and a
  few demo threads, for working on how it looks.

## Commands

```bash
pnpm run build              # dist/extension.js and dist/webview.js
pnpm run watch
pnpm run typecheck
pnpm test                   # the unit tests
pnpm run test:integration   # opens a VS Code window for about 10 s
pnpm run live -- --root samples/shop "How is the total worked out?"
pnpm run live -- --root samples/shop --mode change --test-command "python3 -m unittest -q" "Make discount codes case-sensitive"
node out/test/live/suite.js --out live-results --model ID   # six tasks on one model, checked
node out/test/live/suite.js --out live-results --summary    # a table of every model run so far
pnpm run live:translate -- --base-url https://openrouter.ai/api/v1 --model ID --key-env OPENROUTER_API_KEY --extra '{}' --runs 3
node test/webview/serve.mjs # then http://127.0.0.1:7811/?scene=ask|change|uncommitted|tour|syntax|empty, &theme=light, &level=1
uv run scripts/icon-font.py # media/worsley.ttf, the status bar's sextant, from media/worsley.svg
```

The integration test downloads VS Code 1.101.0, the `engines.vscode` floor,
into `.vscode-test/`. `WORSLEY_TEST_VSCODE` picks another: a version such as
`stable`, or an installed VS Code's binary, such as `/usr/share/code/code`.
`pnpm run live -- --help` lists its options; `--steps` explains a tour's
steps one after another, and `--base-url`, `--model` and `--key-env` point
it at OpenRouter. `live:translate` takes the same, `--cases` to run only
some, and `--show` to print each reply; it ends with a table of how many
translations of each case passed, and how many added nothing to the
pseudocode.

## Not yet

- Only the workspace's first folder is used.
- Thinking is set per backend and mode in the settings (`extraBody`,
  `changeExtraBody`), not in the panel.
- Symbolic links inside the workspace that point out of it aren't stopped.
