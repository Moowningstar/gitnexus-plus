/**
 * A small, dependency-free tokenizer for diff lines.
 *
 * Why hand-written: the client half ships as one CommonJS artifact built by `tsc` with
 * an AMD shim, and only platform baseline modules are resolvable through its `require`
 * — there is no highlighter among them. A real highlighter (shiki, prism) would have to
 * be bundled, which this build deliberately does not do.
 *
 * Scope is deliberately narrow: comments, strings, numbers, and a per-language keyword
 * set. That is what makes a diff readable without pretending to be a parser — and the
 * fallback for an unknown language is a single plain token, so nothing is ever
 * mis-coloured by a guess.
 */

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword';

export interface Token {
  text: string;
  kind: TokenKind;
}

export interface HighlightState {
  blockComment: boolean;
}

interface LanguageRules {
  line: string[];
  block: [string, string] | null;
  keywords: ReadonlySet<string>;
}

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'class', 'extends', 'new', 'this', 'super', 'import', 'from', 'export', 'default',
  'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in',
  'of', 'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected',
  'readonly', 'static', 'as', 'satisfies', 'null', 'undefined', 'true', 'false',
  'switch', 'case', 'break', 'continue', 'yield', 'void', 'never', 'unknown', 'any',
]);

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from',
  'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'async',
  'await', 'pass', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'global',
  'nonlocal', 'del', 'assert',
]);

const SH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
  'function', 'return', 'export', 'local', 'readonly', 'in', 'echo', 'exit', 'set',
  'unset', 'shift', 'source', 'true', 'false',
]);

const PS_KEYWORDS = new Set([
  'param', 'function', 'return', 'if', 'elseif', 'else', 'foreach', 'for', 'while',
  'do', 'switch', 'try', 'catch', 'finally', 'throw', 'New-Item', 'Write-Host',
  'Export-ModuleMember', 'Import-Module', 'Set-StrictMode', 'true', 'false', 'null',
]);

const RULES: Record<string, LanguageRules> = {
  js: { line: ['//'], block: ['/*', '*/'], keywords: JS_KEYWORDS },
  ts: { line: ['//'], block: ['/*', '*/'], keywords: JS_KEYWORDS },
  go: {
    line: ['//'],
    block: ['/*', '*/'],
    keywords: new Set([
      'func', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'type',
      'struct', 'interface', 'map', 'chan', 'go', 'defer', 'var', 'const', 'nil',
      'true', 'false', 'switch', 'case', 'default', 'select',
    ]),
  },
  rust: {
    line: ['//'],
    block: ['/*', '*/'],
    keywords: new Set([
      'fn', 'let', 'mut', 'pub', 'use', 'mod', 'impl', 'trait', 'struct', 'enum',
      'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'self', 'Self',
      'some', 'none', 'ok', 'err', 'async', 'await', 'move', 'where',
    ]),
  },
  java: {
    line: ['//'],
    block: ['/*', '*/'],
    keywords: new Set([
      'public', 'private', 'protected', 'class', 'interface', 'extends', 'implements',
      'return', 'if', 'else', 'for', 'while', 'new', 'static', 'final', 'void',
      'int', 'long', 'double', 'float', 'boolean', 'char', 'true', 'false', 'null',
    ]),
  },
  python: { line: ['#'], block: null, keywords: PY_KEYWORDS },
  shell: { line: ['#'], block: null, keywords: SH_KEYWORDS },
  powershell: { line: ['#'], block: ['<#', '#>'], keywords: PS_KEYWORDS },
  css: { line: [], block: ['/*', '*/'], keywords: new Set(['import', 'media', 'supports']) },
  json: { line: [], block: null, keywords: new Set(['true', 'false', 'null']) },
  yaml: { line: ['#'], block: null, keywords: new Set(['true', 'false', 'null']) },
  toml: { line: ['#'], block: null, keywords: new Set(['true', 'false']) },
  sql: {
    line: ['--'],
    block: ['/*', '*/'],
    keywords: new Set([
      'select', 'from', 'where', 'join', 'left', 'right', 'inner', 'on', 'group',
      'order', 'by', 'limit', 'insert', 'update', 'delete', 'create', 'table',
      'index', 'values', 'and', 'or', 'not', 'null', 'as',
    ]),
  },
};

const EXTENSIONS: Array<[string, string]> = [
  ['.tsx', 'ts'],
  ['.ts', 'ts'],
  ['.jsx', 'js'],
  ['.mjs', 'js'],
  ['.cjs', 'js'],
  ['.js', 'js'],
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.py', 'python'],
  ['.ps1', 'powershell'],
  ['.psm1', 'powershell'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.css', 'css'],
  ['.scss', 'css'],
  ['.json', 'json'],
  ['.jsonc', 'json'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
  ['.toml', 'toml'],
  ['.sql', 'sql'],
];

/** Rules for a path, by extension; `null` means "do not guess". */
export function languageOf(path: string): string | null {
  const lower = path.toLowerCase();
  for (const [extension, language] of EXTENSIONS) {
    if (lower.endsWith(extension)) return language;
  }
  return null;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdent(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Tokenize one line, carrying block-comment state across lines.
 *
 * `state` is mutated: a `/*` that does not close on this line leaves
 * `blockComment = true`, and the next call starts inside the comment. That is the only
 * cross-line state a diff view needs, and it is why this is a scanner rather than a set
 * of per-line regexes.
 */
export function highlightLine(
  line: string,
  language: string | null,
  state: HighlightState,
): Token[] {
  const rules = language === null ? undefined : RULES[language];
  if (rules === undefined) return [{ text: line, kind: 'plain' }];

  const tokens: Token[] = [];
  let buffer = '';
  let i = 0;
  const flush = (): void => {
    if (buffer !== '') {
      tokens.push({ text: buffer, kind: 'plain' });
      buffer = '';
    }
  };

  while (i < line.length) {
    if (state.blockComment) {
      // `state.blockComment` is only ever set below, where `rules.block` is non-null;
      // the local keeps the narrowing legible to the compiler.
      const block = rules.block;
      if (block === null) {
        state.blockComment = false;
        continue;
      }
      const close = line.indexOf(block[1], i);
      if (close < 0) {
        tokens.push({ text: line.slice(i), kind: 'comment' });
        return tokens;
      }
      tokens.push({ text: line.slice(i, close + block[1].length), kind: 'comment' });
      i = close + block[1].length;
      state.blockComment = false;
      continue;
    }

    if (rules.block !== null && line.startsWith(rules.block[0], i)) {
      flush();
      const close = line.indexOf(rules.block[1], i + rules.block[0].length);
      if (close < 0) {
        tokens.push({ text: line.slice(i), kind: 'comment' });
        state.blockComment = true;
        return tokens;
      }
      tokens.push({
        text: line.slice(i, close + rules.block[1].length),
        kind: 'comment',
      });
      i = close + rules.block[1].length;
      continue;
    }

    const lineComment = rules.line.find((prefix) => line.startsWith(prefix, i));
    if (lineComment !== undefined) {
      flush();
      tokens.push({ text: line.slice(i), kind: 'comment' });
      return tokens;
    }

    const ch = line[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      flush();
      let end = i + 1;
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2;
          continue;
        }
        if (line[end] === ch) {
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push({ text: line.slice(i, end), kind: 'string' });
      i = end;
      continue;
    }

    if (isDigit(ch)) {
      flush();
      let end = i + 1;
      while (end < line.length && /[0-9a-fA-FxX._]/.test(line[end] as string)) end += 1;
      tokens.push({ text: line.slice(i, end), kind: 'number' });
      i = end;
      continue;
    }

    if (isIdentStart(ch)) {
      flush();
      let end = i + 1;
      while (end < line.length && isIdent(line[end] as string)) end += 1;
      const word = line.slice(i, end);
      tokens.push({ text: word, kind: rules.keywords.has(word) ? 'keyword' : 'plain' });
      i = end;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return tokens;
}
