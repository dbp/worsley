/**
 * The measure of a translation: what is in the code that isn't in what the
 * student wrote. The code's names, numbers, strings and comments are each
 * looked for in the student's words; the language's own keywords, built-ins
 * and common methods don't count. It is a sieve, not a proof: a made-up
 * check built only from the student's own names gets through it, which is
 * what each case's expectations are for.
 */

export type CheckedLanguage = "python" | "java" | "javascript";

export interface Added {
  /** Names that aren't the student's words, nor the language's. */
  names: string[];
  numbers: string[];
  strings: string[];
  comments: string[];
}

interface Vocabulary {
  /** Names that may stand anywhere: keywords, built-in functions and types. */
  words: ReadonlySet<string>;
  /** Names that may follow a dot: common methods and fields. */
  members: ReadonlySet<string>;
  hashComments: boolean;
}

const set = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

const VOCABULARIES: Record<CheckedLanguage, Vocabulary> = {
  python: {
    words: set(`
      and as assert async await break case class continue def del elif else except False finally for from global if import in is
      lambda match None nonlocal not or pass raise return True try while with yield self _
      abs all any bool chr dict divmod enumerate filter float format input int isinstance len list map max min next open ord pow
      print range repr reversed round set sorted str sum tuple type zip`),
    members: set(`
      append extend insert remove pop clear index count sort reverse copy keys values items get update split join strip lstrip
      rstrip lower upper replace startswith endswith find format add discard isdigit isalpha`),
    hashComments: true,
  },
  java: {
    words: set(`
      abstract assert boolean break byte case catch char class continue default do double else enum extends final finally float
      for if implements import instanceof int interface long new package private protected public return short static super
      switch synchronized this throw throws try var void volatile while true false null
      String System Math Integer Double Boolean Character Scanner ArrayList List Arrays Collections HashMap Map Object`),
    members: set(`
      out in println print printf length size add get set remove contains isEmpty sort equals charAt substring indexOf toString
      parseInt nextInt nextLine next nextDouble max min abs sqrt pow toUpperCase toLowerCase`),
    hashComments: false,
  },
  javascript: {
    words: set(`
      break case catch class const continue default delete do else export extends false finally for function if import in
      instanceof let new null of return super switch this throw true try typeof undefined var void while yield async await
      console Math Number String Array Object JSON parseInt parseFloat prompt alert`),
    members: set(`
      log push pop length sort map filter forEach includes indexOf join split slice toUpperCase toLowerCase floor ceil round max
      min abs keys values`),
    hashComments: false,
  },
};

const NUMBER_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

interface Token {
  kind: "name" | "number" | "string" | "comment";
  text: string;
  /** A name that follows a dot. */
  member?: boolean;
}

/** The names, numbers, strings and comments in some code, roughly as the language reads them. */
export function tokens(code: string, language: CheckedLanguage): Token[] {
  const out: Token[] = [];
  const hash = VOCABULARIES[language].hashComments;
  let i = 0;
  let afterDot = false;
  while (i < code.length) {
    const rest = code.slice(i);
    const ch = code[i] ?? "";
    if ((hash && ch === "#") || rest.startsWith("//")) {
      const end = code.indexOf("\n", i);
      const text = code.slice(i, end < 0 ? code.length : end);
      out.push({ kind: "comment", text: text.replace(/^(#|\/\/)\s*/, "") });
      i += text.length;
      continue;
    }
    if (!hash && rest.startsWith("/*")) {
      const end = code.indexOf("*/", i + 2);
      const text = code.slice(i, end < 0 ? code.length : end + 2);
      out.push({ kind: "comment", text: text.replace(/^\/\*\s*|\s*\*\/$/g, "") });
      i += text.length;
      continue;
    }
    const quote = /^(?:[rRbBuUfF]{1,2}(?=['"]))?("""|'''|"|'|`)/.exec(rest);
    if (quote !== null && (quote[0].length === quote[1]!.length || hash)) {
      const mark = quote[1] as string;
      let j = i + quote[0].length;
      let text = "";
      while (j < code.length && !code.startsWith(mark, j) && (mark.length === 3 || mark === "`" || code[j] !== "\n")) {
        if (code[j] === "\\") {
          text += code.slice(j, j + 2);
          j += 2;
          continue;
        }
        text += code[j];
        j++;
      }
      out.push({ kind: "string", text });
      i = Math.min(code.length, j + mark.length);
      afterDot = false;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(rest);
    if (number !== null) {
      out.push({ kind: "number", text: number[0] });
      i += number[0].length;
      afterDot = false;
      continue;
    }
    const name = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (name !== null) {
      out.push({ kind: "name", text: name[0], member: afterDot });
      i += name[0].length;
      afterDot = false;
      continue;
    }
    if (ch === ".") {
      afterDot = true;
    } else if (!/\s/.test(ch)) {
      afterDot = false;
    }
    i++;
  }
  return out;
}

/** A word without its plural or possessive ending, so that "prices" and "price" meet. */
function stem(word: string): string {
  const w = word.toLowerCase().replace(/'s$/, "");
  if (w.length <= 3) {
    return w;
  }
  if (w.endsWith("ies")) {
    return `${w.slice(0, -3)}y`;
  }
  if (/(?:s|x|z|ch|sh)es$/.test(w)) {
    return w.slice(0, -2);
  }
  return w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

/** The parts of a name: total_price and totalPrice are both "total" and "price". */
function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s\d$]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/**
 * What in `code` isn't in `original`, the student's words. `allow` names
 * names and numbers that a case accepts besides.
 */
export function addedDetails(code: string, original: string, language: CheckedLanguage, allow: readonly string[] = []): Added {
  const vocabulary = VOCABULARIES[language];
  // Code among the student's lines has names of its own, such as totalPrice.
  const words = new Set((original.replace(/([a-z0-9])([A-Z])/g, "$1 $2").match(/[A-Za-z]+(?:'s)?/g) ?? []).map(stem));
  const numbers = new Set<number>();
  for (const n of original.match(/\d+(?:\.\d+)?/g) ?? []) {
    numbers.add(Number(n));
  }
  for (const word of original.toLowerCase().match(/[a-z]+/g) ?? []) {
    const n = NUMBER_WORDS[word];
    if (n !== undefined) {
      numbers.add(n);
    }
  }
  // x++ is x += 1.
  if (/\+\+|--|\bincrement|\bdecrement/i.test(original)) {
    numbers.add(1);
  }
  const lower = original.toLowerCase();
  const allowed = new Set(allow);
  const added: Added = { names: [], numbers: [], strings: [], comments: [] };
  const push = (list: string[], text: string): void => {
    if (!list.includes(text)) {
      list.push(text);
    }
  };
  for (const token of tokens(code, language)) {
    if (allowed.has(token.text)) {
      continue;
    }
    switch (token.kind) {
      case "name": {
        const known = token.member === true ? vocabulary.members.has(token.text) || vocabulary.words.has(token.text) : vocabulary.words.has(token.text);
        if (!known && !nameParts(token.text).every((part) => words.has(stem(part)))) {
          push(added.names, token.text);
        }
        break;
      }
      case "number": {
        const n = Number(token.text);
        // "From 1 to 10" ends a range at 11.
        if (!numbers.has(n) && !numbers.has(n - 1)) {
          push(added.numbers, token.text);
        }
        break;
      }
      case "string":
        if (!lower.includes(token.text.toLowerCase().trim()) || (token.text === "" && !/""|''|empty/.test(lower))) {
          push(added.strings, JSON.stringify(token.text));
        }
        break;
      case "comment":
        if (!lower.includes(token.text.toLowerCase().trim())) {
          push(added.comments, token.text);
        }
        break;
    }
  }
  return added;
}
