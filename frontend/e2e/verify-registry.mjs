import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const file = 'frontend/src/components/ui/geo-traceroute.tsx';
const original = execFileSync('git', ['show', `2bda4e2:${file}`], { encoding: 'utf8', cwd: '..' });
const current = fs.readFileSync('src/components/ui/geo-traceroute.tsx', 'utf8');
function functions(text) {
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const source = ts.createSourceFile('trace.js', output, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  function canonical(node) {
    if (ts.isParenthesizedExpression(node)) return canonical(node.expression);
    const children = []; ts.forEachChild(node, child => { children.push(canonical(child)); });
    return [node.kind, ts.isIdentifier(node) || ts.isLiteralExpression(node) ? node.text : '', children];
  }
  const result = new Map();
  function walk(node) {
    if (ts.isFunctionDeclaration(node) && node.name) result.set(node.name.text, JSON.stringify(canonical(node)));
    ts.forEachChild(node, walk);
  }
  walk(source); return result;
}
const before = functions(original), after = functions(current);
const labelForks = new Set(['GeoTraceroute', 'finish', 'LocationCell']);
const checked = [];
for (const [name, body] of before) {
  if (labelForks.has(name)) continue;
  if (after.get(name) !== body) throw new Error(`Registry runtime changed: ${name}`);
  checked.push(name);
}
console.log(`Registry runtime equivalence: ${checked.length} functions unchanged after TypeScript erasure.`);
console.log(checked.join(', '));
