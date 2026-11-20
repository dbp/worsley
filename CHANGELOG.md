# Changelog

What has changed in each version of Worsley, newest first.

## 0.1.1 - 2026-11-19

Levels, so that a course can bring Worsley in a little at a time. Each
level offers what the one before it does, and more. At the default, level
N, Worsley offers everything it did before, and the new requests besides.

### Added

- `worsley.level`, the level Worsley is at. The menus, keybindings, command
  palette and panel show only what the level offers. A course sets it in the
  `.vscode/settings.json` of the project its students start from.
  - 1, Syntax: Explain This Line and Translate Into Code, both new.
  - 2, Specs: Check This Function and Fill In This Function, both new.
  - 3, Changes: Review My Changes to This File, from 0.1.0.
  - N, Everything, the default: the rest of 0.1.0, which is Ask, Change,
    tours, and Review All My Uncommitted Changes.
- **Explain This Line** (`Ctrl+Alt+X`, `⌘⌥X`) explains the line at the
  cursor on its own, part by part, or the part of it that is selected.
- **Translate Into Code** puts right how the selected code is written, in
  the file's language, and turns its pseudocode into code, in place of the
  selection, which undo brings back. It adds nothing to what the code does:
  a mistake in the logic stays, and a line that asks for code ("write a
  function that sorts the list"), or leaves out something the code needs,
  stays as written, with the reply saying what it would need.
- **Check This Function** reads a function or method against its docstring
  and the tests that call it, and says whether they fit, linking each thing
  that doesn't to the lines on both sides. It changes nothing.
- **Fill In This Function** writes a function's body, in place of a
  placeholder such as `pass`, to do what its docstring and tests say and
  nothing more; undo brings the placeholder back. A function with a body
  already, or with no tests, is left alone, and where the docstring and
  tests contradict each other or say too little, nothing is written and the
  reply says why.
- The requests of levels 1 and 2 each stand alone: the model sees only the
  code a request is about, not the rest of the file or the thread, and has
  no tools.
- Below the thread, a row of buttons for each level up to Worsley's,
  labelled with its number and name, so that a student sees what each level
  added.
- *Level*, at the bottom of the panel beside the model, to choose another
  level. It sets `worsley.level` for the workspace if a course set it there,
  and otherwise for the user.
- A colour icon and a navy banner, for the marketplace.
- `pnpm run live:translate` and `pnpm run live:functions`, which measure
  Translate and level 2's requests against a real model.

### Changed

- **New Thread** is **Clear Thread**, with a trash can, since it clears the
  thread for good. It is still the command `worsley.newThread`, so a
  keybinding for it still works.
- With nothing in the thread, the panel says what the level's requests do.
- Worsley starts with VS Code, rather than when it is first used, so that
  its menus and keybindings fit the level from the start.
- The README, and the description the marketplace shows, start with the
  levels.

## 0.1.0 - 2026-11-10

The first version: an assistant in a side panel that answers by pointing
into the code, with every claim linked to the lines it is about. Its
backend is any OpenAI-compatible chat endpoint with tool calls: a local
llama.cpp server, the default, OpenRouter, or a server of your own.

- **Ask About This Code…** (`Ctrl+Alt+A`, `⌘⌥A`), with the selection and
  the visible files. Asking where something happens lists every place, and
  *Peek all* shows them in the editor's peek view.
- **Tour the Codebase**, through its structure: its components, the
  interfaces between them, and the tests that hold them in place. A question
  about how something works gets a walk through the code instead, a step at
  a time in the editor.
- **Change This Code…** (`Ctrl+Alt+E`, `⌘⌥E`), across the codebase, with
  the tests updated or added and run until they pass. Commands other than
  the configured test command wait for approval, which can cover a class of
  commands, and **Allowed Commands…** takes it back. Nothing is staged or
  committed, and a change waits, with a card, when something is already
  uncommitted.
- **Review My Changes to This File** and **Review All My Uncommitted
  Changes**: light reviews of what you have changed and not committed, for
  what else it calls for.
- Threads kept inside the model's context window, by clearing old tool
  results and then summarizing, and across reloads and restarts of VS Code.
- **Choose Model…**, with the last six models first, and servers of your
  own; keys kept in VS Code's secret storage; and, in the status bar, what
  an OpenRouter key has spent today.
- Links in replies checked once a reply is complete, with those to files
  that don't exist struck through.
- Disabled in untrusted workspaces, since it runs their commands.
