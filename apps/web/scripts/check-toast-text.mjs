// Fails when text shown in a toast contains an em dash, en dash or " - ".
// Uses a real TypeScript program + type checker so it follows what actually
// reaches a toast, not just literals written inline:
//   - string literals/templates passed to toast helpers (aliased imports too)
//   - identifiers that resolve to a const initializer, object shorthand
//     properties, quoted keys, and the return expressions of local functions
//   - `errorTitle` / `successMessage` meta and describeError fallbacks
//   - every string literal inside lib/toast.ts (status messages, fallbacks)
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = join(WEB_DIR, 'src');
const TOAST_LIB = join(ROOT, 'lib', 'toast.ts');
const CALLEES = new Set([
  'toast.success',
  'toast.error',
  'toast.info',
  'toast.warning',
  'toast.message',
  'toastError',
  'toastSuccess',
  'toastInfo',
  'toastErrorMessage',
  'describeError',
  'showError',
]);
const PROPS = new Set(['errorTitle', 'successMessage']);
// Dashes used as punctuation, plus hyphenated words we always rephrase.
const BAD =
  /[—–]| - |\b(?:sign|log|check|set)-(?:in|out|up)\b|\bre-(?:queued|apply|send|try)\b|\bfollow-up\b|\baudio-only\b/i;

const configPath = join(WEB_DIR, 'tsconfig.json');
const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dirname(configPath));
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();

const norm = (p) => resolve(p).toLowerCase();
const inRoot = (sf) => norm(sf.fileName).startsWith(norm(ROOT)) && !sf.isDeclarationFile;

function resolveSymbol(node) {
  let sym = checker.getSymbolAtLocation(node);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return sym;
}

/** `toast.success`, `toastError`, ... following aliased imports back to the real name. */
function calleeName(expr) {
  if (ts.isIdentifier(expr)) return resolveSymbol(expr)?.name ?? expr.text;
  if (ts.isPropertyAccessExpression(expr)) return `${calleeName(expr.expression)}.${expr.name.text}`;
  return '';
}

function returnsOf(fn, found, seen) {
  if (!fn.body) return;
  if (!ts.isBlock(fn.body)) {
    collect(fn.body, found, seen);
    return;
  }
  const visit = (n) => {
    if (n !== fn && ts.isFunctionLike(n)) return; // nested functions return elsewhere
    if (ts.isReturnStatement(n) && n.expression) collect(n.expression, found, seen);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
}

function collectDecl(decl, found, seen) {
  if (!decl || seen.has(decl)) return;
  seen.add(decl);
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) returnsOf(init, found, seen);
    else collect(init, found, seen);
  } else if (ts.isFunctionDeclaration(decl)) returnsOf(decl, found, seen);
  else if (ts.isPropertyAssignment(decl)) collect(decl.initializer, found, seen);
}

/** Every string literal node that can reach `node`'s value. */
function collect(node, found = [], seen = new Set()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node);
  else if (ts.isTemplateExpression(node)) {
    found.push(node.head);
    node.templateSpans.forEach((s) => {
      found.push(s.literal);
      collect(s.expression, found, seen);
    });
  } else if (ts.isObjectLiteralExpression(node)) {
    node.properties.forEach((p) => {
      if (ts.isPropertyAssignment(p)) collect(p.initializer, found, seen);
      else if (ts.isShorthandPropertyAssignment(p)) {
        collectDecl(checker.getShorthandAssignmentValueSymbol(p)?.valueDeclaration, found, seen);
      }
    });
  } else if (ts.isArrayLiteralExpression(node)) {
    node.elements.forEach((e) => collect(e, found, seen));
  } else if (ts.isConditionalExpression(node)) {
    collect(node.whenTrue, found, seen);
    collect(node.whenFalse, found, seen);
  } else if (ts.isBinaryExpression(node)) {
    collect(node.left, found, seen);
    collect(node.right, found, seen);
  } else if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    collect(node.expression, found, seen);
  } else if (ts.isIdentifier(node)) {
    collectDecl(resolveSymbol(node)?.valueDeclaration, found, seen);
  } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    // `MESSAGES[code]` / `MESSAGES.key`: check the whole const object.
    collect(node.expression, found, seen);
  } else if (ts.isCallExpression(node)) {
    const decl = resolveSymbol(node.expression)?.valueDeclaration;
    if (decl && !CALLEES.has(calleeName(node.expression))) collectDecl(decl, found, seen);
  }
  return found;
}

const problems = new Set();
function report(sf, lit) {
  if (!BAD.test(lit.text)) return;
  const at = ts.getLineAndCharacterOfPosition(lit.getSourceFile(), lit.getStart());
  problems.add(`${relative(ROOT, lit.getSourceFile().fileName)}:${at.line + 1}: ${JSON.stringify(lit.text)}`);
}

for (const sf of program.getSourceFiles()) {
  if (!inRoot(sf)) continue;
  const isToastLib = norm(sf.fileName) === norm(TOAST_LIB);
  const visit = (node) => {
    if (ts.isCallExpression(node) && CALLEES.has(calleeName(node.expression))) {
      node.arguments.forEach((arg) => collect(arg).forEach((l) => report(sf, l)));
    }
    const named =
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      PROPS.has(node.name.text);
    if (named) {
      // A shorthand `{ errorTitle }` must resolve to the variable it names,
      // not to the property symbol (whose declaration is the shorthand itself).
      const lits = ts.isPropertyAssignment(node)
        ? collect(node.initializer)
        : (() => {
            const found = [];
            collectDecl(checker.getShorthandAssignmentValueSymbol(node)?.valueDeclaration, found, new Set());
            return found;
          })();
      lits.forEach((l) => report(sf, l));
    }
    // The toast library's own status messages and fallbacks reach users too.
    if (isToastLib && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      if (!ts.isImportDeclaration(node.parent)) report(sf, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (problems.size) {
  console.error('Toast text must not contain em dashes, en dashes or " - ":\n' + [...problems].join('\n'));
  process.exit(1);
}
console.log('check-toast-text: ok');
