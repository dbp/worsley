/**
 * Command lines, read as far as is needed to decide whether one may run
 * without asking. "Always allow" can cover a class of commands, such as
 * `cargo test` with any arguments. A line runs without asking when every
 * simple command in it is covered: `cargo test 2>&1 | tail -20` does once
 * `cargo test …` and `tail …` are allowed, and `cargo test; rm -rf ~`
 * doesn't. A line this can't see through (command substitution, a
 * subshell, a here-document, a control structure) is only ever allowed
 * as exactly that line.
 */

/** One program run: `NAME=value` assignments first, then the program and its arguments. */
export interface SimpleCommand {
  words: string[];
  /** Whether each word is what the shell passes on as written: no `$` expansion, glob or `~` in it. */
  literal: boolean[];
  /** It redirects output into a file. */
  writes: boolean;
}

/** What "Always allow" has covered in a workspace. */
export interface CommandRules {
  /** Whole lines, allowed exactly as written. */
  exact: string[];
  /** A simple command that starts with one of these, whatever follows, is allowed. */
  prefixes: string[][];
}

/** Words that start shell syntax this doesn't read: control structures, groups, negation. */
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until", "do", "done", "function", "time", "coproc", "!", "{", "}", "[[", "]]"]);

/** The simple commands of `line`, or undefined when it can't be seen through. */
export function parseCommandLine(line: string): SimpleCommand[] | undefined {
  const commands: SimpleCommand[] = [];
  let command: SimpleCommand = { words: [], literal: [], writes: false };
  let word = "";
  // A word may be empty but present, as `""` is.
  let started = false;
  let literal = true;
  // Nothing in the word was quoted or escaped, so `2` in `2>` is a descriptor.
  let bare = true;
  // A redirection waiting for the word it redirects to.
  let redirect: string | undefined;

  const endWord = (): boolean => {
    if (!started) {
      return true;
    }
    if (redirect !== undefined) {
      command.writes ||= writesTo(redirect, word);
      redirect = undefined;
    } else {
      if (bare && command.words.length === 0 && RESERVED.has(word)) {
        return false;
      }
      command.words.push(word);
      command.literal.push(literal);
    }
    word = "";
    started = false;
    literal = true;
    bare = true;
    return true;
  };
  const endCommand = (): boolean => {
    if (!endWord() || redirect !== undefined) {
      return false;
    }
    // `> file` alone still empties the file.
    if (command.words.length > 0 || command.writes) {
      commands.push(command);
    }
    command = { words: [], literal: [], writes: false };
    return true;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    const next = line[i + 1];
    if (c === "\\") {
      if (next === undefined) {
        return undefined;
      }
      // A backslash before a newline joins the lines.
      if (next !== "\n") {
        word += next;
        started = true;
        bare = false;
      }
      i++;
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) {
        return undefined;
      }
      word += line.slice(i + 1, close);
      started = true;
      bare = false;
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j] as string;
        if (d === "\\" && j + 1 < line.length && '$`"\\\n'.includes(line[j + 1] as string)) {
          if (line[j + 1] !== "\n") {
            word += line[j + 1];
          }
          j++;
        } else if (d === "`" || (d === "$" && line[j + 1] === "(")) {
          return undefined;
        } else {
          if (d === "$") {
            literal = false;
          }
          word += d;
        }
      }
      if (j >= line.length) {
        return undefined;
      }
      started = true;
      bare = false;
      i = j;
    } else if (c === "`" || c === "(" || c === ")" || (c === "$" && (next === "(" || next === "'"))) {
      // Command substitution, a subshell, or $'…' quoting.
      return undefined;
    } else if (c === "#" && !started) {
      const end = line.indexOf("\n", i);
      i = end < 0 ? line.length : end - 1;
    } else if (c === " " || c === "\t") {
      if (!endWord()) {
        return undefined;
      }
    } else if (c === "<" || c === ">" || (c === "&" && next === ">")) {
      // Digits right before are the descriptor redirected, as in `2>&1`.
      if (started && bare && /^\d+$/.test(word)) {
        word = "";
        started = false;
      } else if (!endWord()) {
        return undefined;
      }
      if (redirect !== undefined) {
        return undefined;
      }
      const op = (/^(?:&>>|&>|<<<|<<-?|<>|<&|>>|>\||>&|<|>)/.exec(line.slice(i)) as RegExpExecArray)[0];
      if (op.startsWith("<<") && op !== "<<<") {
        return undefined;
      }
      redirect = op;
      i += op.length - 1;
    } else if (c === ";" || c === "\n" || c === "|" || c === "&") {
      if (c === ";" && next === ";") {
        return undefined;
      }
      if (!endCommand()) {
        return undefined;
      }
      if ((c === "|" && (next === "|" || next === "&")) || (c === "&" && next === "&")) {
        i++;
      }
    } else {
      if ("*?[{".includes(c) || (c === "~" && !started) || c === "$") {
        literal = false;
      }
      word += c;
      started = true;
    }
  }
  return endCommand() ? commands : undefined;
}

function writesTo(op: string, target: string): boolean {
  if (op === "<" || op === "<<<" || op === "<&") {
    return false;
  }
  if (op === ">&" && /^(?:\d+|-)$/.test(target)) {
    return false;
  }
  return target !== "/dev/null";
}

/** Whether `line` may run without asking under `rules`. */
export function allowedBy(rules: CommandRules, line: string): boolean {
  const text = line.trim();
  if (rules.exact.includes(text)) {
    return true;
  }
  const commands = parseCommandLine(text);
  return commands !== undefined && commands.length > 0 && commands.every((command) => covered(rules, command));
}

function covered(rules: CommandRules, command: SimpleCommand): boolean {
  return !command.writes && rules.prefixes.some((prefix) => startsWith(command, prefix));
}

function startsWith(command: SimpleCommand, prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.length <= command.words.length && prefix.every((word, i) => command.literal[i] === true && command.words[i] === word);
}

/** What "Always allow" can cover, as the approval card offers it. */
export interface Scope {
  /** `cargo test …`, `grep … and head …`, or EXACTLY. */
  label: string;
  rules: CommandRules;
}

export const EXACTLY = "exactly this command";

/**
 * Programs for which no class is offered, only the exact line: shells and
 * what runs other programs, and what deletes, moves, kills or reaches the
 * network, whatever the arguments.
 */
const NO_CLASS = new Set(
  (
    "sh bash zsh fish dash ksh csh tcsh eval exec source . command builtin sudo doas su pkexec env xargs nohup nice ionice " +
    "time timeout watch strace ltrace chroot flock stdbuf parallel rm rmdir mv cp dd ln chmod chown chgrp truncate shred " +
    "mkfs mount umount kill pkill killall systemctl service reboot shutdown curl wget ssh scp sftp rsync nc ncat netcat " +
    "socat telnet ftp tee crontab at open xdg-open"
  ).split(" "),
);

/** Programs that write files or run commands with the right arguments: a class is offered, but the exact line suggested. */
const CAREFUL = new Set("find sed awk gawk mawk tar unzip zip gzip gunzip patch touch mkdir docker podman kubectl terraform helm".split(" "));

/** Programs whose first argument is a subcommand that says what they do, as `cargo test`. */
const SUBCOMMANDS = new Set(
  (
    "cargo git go npm pnpm yarn bun deno dotnet docker podman kubectl gh uv poetry pip pip3 pipx rustup make cmake mvn gradle " +
    "./gradlew mix rake bundle swift zig nix brew terraform helm conda hatch pdm tox nox just"
  ).split(" "),
);

/** Subcommands after which the next word names what runs, as `npm run build`. */
const RUNS: Record<string, string[]> = {
  npm: ["run", "run-script", "exec", "x"],
  pnpm: ["run", "exec", "dlx"],
  yarn: ["run", "exec", "dlx"],
  bun: ["run", "x"],
  uv: ["run", "tool"],
  poetry: ["run"],
  pipx: ["run"],
  bundle: ["exec"],
  go: ["run"],
};

/** These run the package named next, as `npx tsc`. */
const RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx"]);

/** Interpreters: the class takes in what they run, a script or `-m module`. */
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "php", "java"]);

/** Interpreter options that run code given on the command line, or load it first. */
const INLINE = new Set(["-c", "-e", "-E", "-p", "-r", "-n", "--eval", "--print", "--require", "--import", "--loader"]);

/**
 * How many leading words make up a command's class, which "Always allow"
 * suggests: the program, with its subcommand or what it runs; undefined
 * when no class should be offered.
 */
function classOf(command: SimpleCommand): { length: number; careful: boolean } | undefined {
  const { words } = command;
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) {
    i++;
  }
  const program = words[i];
  if (program === undefined) {
    return undefined;
  }
  const name = program.startsWith("./") ? program : (program.split("/").pop() ?? program);
  if (NO_CLASS.has(name)) {
    return undefined;
  }
  const careful = CAREFUL.has(name);
  let end = i + 1;
  const at = (n: number): string | undefined => words[n];
  if (INTERPRETERS.has(name)) {
    // Options, then `-m module` or the script; an option that takes a
    // value would be taken for the script, so only a file or a module counts.
    let module = false;
    while (at(end)?.startsWith("-") === true) {
      const flag = at(end) as string;
      if (INLINE.has(flag)) {
        return undefined;
      }
      end++;
      if (flag === "-m" || flag === "-jar") {
        module = true;
        break;
      }
    }
    const target = at(end);
    if (target === undefined || (!module && !/[./]/.test(target))) {
      return undefined;
    }
    return { length: end + 1, careful };
  }
  if (RUNNERS.has(name)) {
    const target = at(end);
    return target === undefined || target.startsWith("-") ? undefined : { length: end + 1, careful };
  }
  if (SUBCOMMANDS.has(name)) {
    // A toolchain, as in `cargo +nightly test`.
    while (at(end)?.startsWith("+") === true) {
      end++;
    }
    // Options before the subcommand may take values, which would look like one.
    const sub = at(end);
    if (sub === undefined || sub.startsWith("-")) {
      return undefined;
    }
    end++;
    if (RUNS[name]?.includes(sub) === true) {
      const target = at(end);
      if (target === undefined || target.startsWith("-")) {
        return undefined;
      }
      end++;
    }
  }
  return { length: end, careful };
}

/**
 * What "Always allow" can cover for `line`: its class and one word more,
 * or for a pipeline or list, the class of each command not covered yet;
 * then the exact line. `suggested` is the class, unless it is too broad to
 * suggest.
 */
export function scopesFor(line: string, rules: CommandRules): { scopes: Scope[]; suggested: number } {
  const text = line.trim();
  const exact: Scope = { label: EXACTLY, rules: { exact: [text], prefixes: [] } };
  const commands = parseCommandLine(text);
  if (commands === undefined || commands.length === 0 || commands.some((c) => c.writes)) {
    return { scopes: [exact], suggested: 0 };
  }
  const literalTo = (command: SimpleCommand, n: number): boolean => command.literal.slice(0, n).every(Boolean);

  const single = commands.length === 1 ? commands[0] : undefined;
  if (single !== undefined) {
    const kind = classOf(single);
    if (kind === undefined || !literalTo(single, kind.length)) {
      return { scopes: [exact], suggested: 0 };
    }
    const scopes: Scope[] = [];
    for (let n = kind.length; n <= Math.min(kind.length + 1, single.words.length) && literalTo(single, n); n++) {
      const words = single.words.slice(0, n);
      scopes.push({ label: `${quoteWords(words)} …`, rules: { exact: [], prefixes: [words] } });
    }
    scopes.push(exact);
    return { scopes, suggested: kind.careful ? scopes.length - 1 : 0 };
  }

  const prefixes: string[][] = [];
  let careful = false;
  for (const command of commands.filter((c) => !covered(rules, c))) {
    const kind = classOf(command);
    if (kind === undefined || !literalTo(command, kind.length)) {
      return { scopes: [exact], suggested: 0 };
    }
    careful ||= kind.careful;
    const words = command.words.slice(0, kind.length);
    if (!prefixes.some((p) => p.join("\0") === words.join("\0"))) {
      prefixes.push(words);
    }
  }
  const label = listed(prefixes.map((p) => `${quoteWords(p)} …`));
  return { scopes: [{ label, rules: { exact: [], prefixes } }, exact], suggested: careful ? 1 : 0 };
}

/** Rules with `more` added, once each. */
export function withRules(rules: CommandRules, more: CommandRules): CommandRules {
  const exact = [...new Set([...rules.exact, ...more.exact])];
  const prefixes = [...rules.prefixes];
  for (const prefix of more.prefixes) {
    if (!prefixes.some((p) => p.join("\0") === prefix.join("\0"))) {
      prefixes.push(prefix);
    }
  }
  return { exact, prefixes };
}

/** Words as they could be typed back: quoted where the shell would need it. */
export function quoteWords(words: readonly string[]): string {
  return words.map((w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
