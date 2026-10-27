/**
 * Invoice template engine: a small, dependency-free subset of Handlebars.
 *
 * Invoice templates are HTML files that people edit by hand, so the syntax is
 * the familiar Handlebars one. Supported:
 *
 *   {{path}}                      escaped value, e.g. {{client.name}}
 *   {{{path}}}                    raw value (only for trusted template data)
 *   {{helper arg "literal" 2}}    helper call
 *   {{#if expr}} .. {{else}} .. {{/if}}
 *   {{#unless expr}} .. {{/unless}}
 *   {{#each list}} .. {{/each}}   with this, @index, @number, @first, @last
 *   {{#with obj}} .. {{/with}}
 *   (helper args)                 sub-expression inside another tag
 *   ../path                       parent scope inside each / with
 *   {{! comment }}
 *
 * Every value is HTML-escaped unless the triple-stash form is used, so
 * invoice content typed by users (notes, line item descriptions) can never
 * inject markup into the rendered document.
 */

export class TemplateError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'TemplateError';
  }
}

export type HelperFn = (...args: unknown[]) => unknown;

/** Marks a helper result as already-safe HTML (skips escaping). */
export class SafeString {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'value'; expr: Expr; raw: boolean; line: number }
  | {
      kind: 'block';
      name: 'if' | 'unless' | 'each' | 'with';
      expr: Expr;
      body: Node[];
      inverse: Node[];
      line: number;
    };

type Expr =
  | { kind: 'path'; parts: string[]; up: number; special: string | null }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'call'; helper: string; args: Expr[] };

interface Frame {
  ctx: unknown;
  data: Record<string, unknown>;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]!);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

function tokenizeArgs(input: string, line: number): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = input.indexOf(c, i + 1);
      if (end === -1) throw new TemplateError('Unterminated string literal', line);
      tokens.push(input.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (c === '(') {
      let depth = 0;
      let j = i;
      for (; j < input.length; j++) {
        if (input[j] === '(') depth++;
        else if (input[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw new TemplateError('Unbalanced parentheses', line);
      tokens.push(input.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < input.length && !/\s/.test(input[j]!) && input[j] !== '(') j++;
    tokens.push(input.slice(i, j));
    i = j;
  }
  return tokens;
}

function parseAtom(token: string, line: number): Expr {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return { kind: 'literal', value: token.slice(1, -1) };
  }
  if (token.startsWith('(') && token.endsWith(')')) {
    return parseExpr(token.slice(1, -1), line);
  }
  if (/^-?\d+(\.\d+)?$/.test(token)) return { kind: 'literal', value: Number(token) };
  if (token === 'true' || token === 'false') return { kind: 'literal', value: token === 'true' };
  if (token === 'null') return { kind: 'literal', value: null };
  let rest = token;
  let up = 0;
  while (rest.startsWith('../')) {
    up++;
    rest = rest.slice(3);
  }
  if (rest.startsWith('@')) return { kind: 'path', parts: [], up, special: rest.slice(1) };
  if (rest === 'this' || rest === '.') return { kind: 'path', parts: [], up, special: null };
  if (rest.startsWith('this.')) rest = rest.slice(5);
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\.\d+)*$/.test(rest)) {
    throw new TemplateError(`Invalid expression "${token}"`, line);
  }
  return { kind: 'path', parts: rest.split('.'), up, special: null };
}

function parseExpr(input: string, line: number): Expr {
  const tokens = tokenizeArgs(input.trim(), line);
  if (tokens.length === 0) throw new TemplateError('Empty expression', line);
  if (tokens.length === 1) return parseAtom(tokens[0]!, line);
  const [head, ...rest] = tokens;
  if (!/^[A-Za-z_][\w]*$/.test(head!)) {
    throw new TemplateError(`"${head}" is not a helper name`, line);
  }
  return { kind: 'call', helper: head!, args: rest.map((t) => parseAtom(t, line)) };
}

export function parseTemplate(source: string): Node[] {
  const root: Node[] = [];
  const stack: { node: Extract<Node, { kind: 'block' }>; inElse: boolean }[] = [];
  const target = (): Node[] => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    return top.inElse ? top.node.inverse : top.node.body;
  };

  const re = /\{\{(\{?)([\s\S]*?)\}?\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const line = lineAt(source, m.index);
    if (m.index > last) target().push({ kind: 'text', value: source.slice(last, m.index) });
    last = re.lastIndex;
    const raw = m[1] === '{';
    const inner = m[2]!.trim();
    if (inner.startsWith('!')) continue;

    if (inner.startsWith('#')) {
      const space = inner.search(/\s/);
      const name = (space === -1 ? inner.slice(1) : inner.slice(1, space)) as string;
      if (!['if', 'unless', 'each', 'with'].includes(name)) {
        throw new TemplateError(`Unknown block "#${name}"`, line);
      }
      if (space === -1) throw new TemplateError(`"#${name}" needs an argument`, line);
      const node: Extract<Node, { kind: 'block' }> = {
        kind: 'block',
        name: name as 'if' | 'unless' | 'each' | 'with',
        expr: parseExpr(inner.slice(space + 1), line),
        body: [],
        inverse: [],
        line,
      };
      target().push(node);
      stack.push({ node, inElse: false });
      continue;
    }
    if (inner === 'else') {
      const top = stack[stack.length - 1];
      if (!top) throw new TemplateError('{{else}} outside a block', line);
      top.inElse = true;
      continue;
    }
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const top = stack.pop();
      if (!top || top.node.name !== name) {
        throw new TemplateError(`Unexpected {{/${name}}}`, line);
      }
      continue;
    }
    target().push({ kind: 'value', expr: parseExpr(inner, line), raw, line });
  }
  if (last < source.length) target().push({ kind: 'text', value: source.slice(last) });
  const open = stack.pop();
  if (open) throw new TemplateError(`Unclosed {{#${open.node.name}}}`, open.node.line);
  return root;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value) && value !== '0';
}

function evaluate(expr: Expr, frames: Frame[], helpers: Record<string, HelperFn>, line: number): unknown {
  if (expr.kind === 'literal') return expr.value;
  if (expr.kind === 'call') {
    const fn = helpers[expr.helper];
    if (!fn) throw new TemplateError(`Unknown helper "${expr.helper}"`, line);
    return fn(...expr.args.map((a) => evaluate(a, frames, helpers, line)));
  }
  const frame = frames[Math.max(0, frames.length - 1 - expr.up)]!;
  if (expr.special !== null) return frame.data[expr.special];
  let value: unknown = frame.ctx;
  for (const part of expr.parts) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  // A bare name not found in the current scope falls back to the root, so
  // `{{company.name}}` works inside `{{#each lineItems}}`.
  if (value === undefined && expr.up === 0 && expr.parts.length > 0 && frames.length > 1) {
    let rootValue: unknown = frames[0]!.ctx;
    for (const part of expr.parts) {
      if (rootValue === null || rootValue === undefined) return undefined;
      rootValue = (rootValue as Record<string, unknown>)[part];
    }
    return rootValue;
  }
  return value;
}

function renderNodes(nodes: Node[], frames: Frame[], helpers: Record<string, HelperFn>, out: string[]): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      out.push(node.value);
      continue;
    }
    if (node.kind === 'value') {
      const value = evaluate(node.expr, frames, helpers, node.line);
      if (value === null || value === undefined) continue;
      if (value instanceof SafeString) out.push(value.value);
      else out.push(node.raw ? String(value) : escapeHtml(String(value)));
      continue;
    }
    const value = evaluate(node.expr, frames, helpers, node.line);
    const top = frames[frames.length - 1]!;
    switch (node.name) {
      case 'if':
        renderNodes(truthy(value) ? node.body : node.inverse, frames, helpers, out);
        break;
      case 'unless':
        renderNodes(truthy(value) ? node.inverse : node.body, frames, helpers, out);
        break;
      case 'with':
        if (value === null || value === undefined) renderNodes(node.inverse, frames, helpers, out);
        else renderNodes(node.body, [...frames, { ctx: value, data: top.data }], helpers, out);
        break;
      case 'each': {
        const list = Array.isArray(value) ? value : [];
        if (list.length === 0) {
          renderNodes(node.inverse, frames, helpers, out);
          break;
        }
        list.forEach((item, index) => {
          renderNodes(
            node.body,
            [
              ...frames,
              {
                ctx: item,
                data: {
                  ...top.data,
                  index,
                  number: index + 1,
                  first: index === 0,
                  last: index === list.length - 1,
                },
              },
            ],
            helpers,
            out,
          );
        });
        break;
      }
    }
  }
}

export interface CompiledTemplate {
  render(context: unknown): string;
}

export function compileTemplate(source: string, helpers: Record<string, HelperFn>): CompiledTemplate {
  const ast = parseTemplate(source);
  return {
    render(context: unknown): string {
      const out: string[] = [];
      renderNodes(ast, [{ ctx: context, data: {} }], helpers, out);
      return out.join('');
    },
  };
}
