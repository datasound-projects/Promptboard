import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { extractProtectedLiterals, verifyPrompt } from '../src/verification.mjs';

test('recognizes exact code, quotes, URLs and paths without nested duplicates', () => {
  const source = [
    'Fix this code:',
    '```js',
    'const path = "src/über.ts";',
    'console.log(`value: ${path}`);',
    '```',
    'Run `npm test -- --runInBand`. Keep “Nie znaleziono pliku”.',
    'Read https://example.test/doc?q=one&lang=pl, then update src/main.ts and package.json.',
  ].join('\n');
  assert.deepEqual(extractProtectedLiterals(source), [
    { kind: 'fenced-code', text: 'const path = "src/über.ts";\nconsole.log(`value: ${path}`);' },
    { kind: 'inline-code', text: 'npm test -- --runInBand' },
    { kind: 'quoted-text', text: 'Nie znaleziono pliku' },
    { kind: 'url', text: 'https://example.test/doc?q=one&lang=pl' },
    { kind: 'path', text: 'src/main.ts' },
    { kind: 'path', text: 'package.json' },
  ]);
});

test('deduplicates the same literal across formatting while keeping source order', () => {
  assert.deepEqual(extractProtectedLiterals('Use `src/a.ts`, src/a.ts, and "src/a.ts". Then open README.md.'), [
    { kind: 'inline-code', text: 'src/a.ts' },
    { kind: 'path', text: 'README.md' },
  ]);
  assert.deepEqual(extractProtectedLiterals('Use src/a.ts, and later `src/a.ts`.'), [{ kind: 'inline-code', text: 'src/a.ts' }]);
  assert.equal(verifyPrompt('Use src/a.ts, and later `src/a.ts`.', 'Use src/a.ts.').status, 'issues');
});

test('preserves internal code whitespace and Unicode; only CRLF is normalized', () => {
  const source = '  ~~~~py\r\n  słowo = "żółć"\r\n\r\n  print(słowo)\r\n ~~~~~\r\n';
  const expected = '  słowo = "żółć"\n\n  print(słowo)';
  assert.deepEqual(extractProtectedLiterals(source), [{ kind: 'fenced-code', text: expected }]);
  assert.equal(verifyPrompt(source, 'Keep this code:\n```py\n' + expected + '\n```').status, 'pass');
  assert.equal(verifyPrompt(source, expected.replace('  print', 'print')).status, 'issues');
  assert.equal(verifyPrompt('Use `é`.', 'Use `e\u0301`.').status, 'issues');
});

test('handles longer fences and unclosed fences without parsing nested tokens', () => {
  const input = '````md\n```js\nconst n = 1;\n```\n`````\nOpen `x`.\n~~~txt\n"unfinished source"';
  assert.deepEqual(extractProtectedLiterals(input), [
    { kind: 'fenced-code', text: '```js\nconst n = 1;\n```' },
    { kind: 'inline-code', text: 'x' },
    { kind: 'fenced-code', text: '"unfinished source"' },
  ]);
  assert.deepEqual(extractProtectedLiterals('```\n\n```'), []);
});

test('inline code uses matching backtick-run sizes and keeps literal backticks', () => {
  assert.deepEqual(extractProtectedLiterals('Use ``a `literal` here`` and `b`. Ignore a lone `.'), [
    { kind: 'inline-code', text: 'a `literal` here' },
    { kind: 'inline-code', text: 'b' },
  ]);
  assert.deepEqual(extractProtectedLiterals('A \\``escaped delimiter and no closing span.'), []);
});

test('quoted contents can contain inline code, and code can contain quoted contents', () => {
  assert.deepEqual(extractProtectedLiterals('Keep "Use `src/a.ts` exactly" and `say("hello")`.'), [
    { kind: 'quoted-text', text: 'Use `src/a.ts` exactly' },
    { kind: 'inline-code', text: 'say("hello")' },
  ]);
});

test('escaped quotes, contractions, inches, and German/Polish quotation marks have explicit behavior', () => {
  const input = 'Don\'t translate "Say \\"hello\\" now". Keep „Datei fehlt“ and „Brak pliku”. The screen is 16" wide.';
  assert.deepEqual(extractProtectedLiterals(input), [
    { kind: 'quoted-text', text: 'Say \\"hello\\" now' },
    { kind: 'quoted-text', text: 'Datei fehlt' },
    { kind: 'quoted-text', text: 'Brak pliku' },
  ]);
  assert.equal(verifyPrompt(input, 'Use "Say \\"hello\\" now", "Datei fehlt", and "Brak pliku".', 'de').status, 'pass');
  assert.equal(verifyPrompt(input, 'Use Say hello now, Datei fehlt, and Brak pliku.', 'pl').status, 'issues');
});

test('URL punctuation is separated while balanced parentheses and IPv6 remain', () => {
  const input = "Read [guide](https://example.test/Function_(math)), https://[::1]:4318/a?x=1&y=2. Also 'https://example.test/start'.";
  assert.deepEqual(extractProtectedLiterals(input), [
    { kind: 'url', text: 'https://example.test/Function_(math)' },
    { kind: 'url', text: 'https://[::1]:4318/a?x=1&y=2' },
    { kind: 'url', text: 'https://example.test/start' },
  ]);
  assert.equal(verifyPrompt(input, 'Read https://example.test/Function_(math), https://[::1]:4318/a?x=1&y=2, and https://example.test/start.').status, 'pass');
});

test('recognizes Unix, Windows, UNC, relative paths and common standalone filenames', () => {
  const input = 'Edit /tmp/result.json, ./src/main.ts, ../lib/a.js, ~/project, C:\\work\\app.js, \\\\server\\share\\a.txt, src/components, config/settings.toml, README.md, .gitignore and Dockerfile.';
  assert.deepEqual(extractProtectedLiterals(input).map(literal => literal.text), [
    '/tmp/result.json', './src/main.ts', '../lib/a.js', '~/project', 'C:\\work\\app.js', '\\\\server\\share\\a.txt',
    'src/components', 'config/settings.toml', 'README.md', '.gitignore', 'Dockerfile',
  ]);
  assert.deepEqual(extractProtectedLiterals('Use 1/2 of the amount and/or ask. Version 2.4.0 can run in 30 ms.'), []);
});

test('changed snippets, paths, URLs, quoted text and translations are failures', () => {
  const cases = [
    ['Keep `const n = 30;`.', 'Keep `const n = 300;`.'],
    ['Fix src/main.ts.', 'Fix src/main.tsx.'],
    ['Fix src/main.ts.', 'Fix new/src/main.ts.'],
    ['Read https://example.test/a.', 'Read https://example.test/a?new=true.'],
    ['Read https://example.test/a.', 'Read https://example.test/abc.'],
    ['Keep "Brak pliku".', 'Keep "File not found".'],
    ['Keep `npm test`.', 'Keep `npm run test`.'],
  ];
  for (const [input, output] of cases) {
    const result = verifyPrompt(input, output);
    assert.equal(result.status, 'issues', input);
    assert.equal(result.matchedCount, 0);
    assert.equal(result.issues[0].rule, 'protected-literal');
    assert.equal(result.checks.find(check => check.id === 'protected-literals').status, 'fail');
  }
});

test('a literal substring inside a changed delimited span is not preservation', () => {
  const cases = [
    ['Run `npm test`.', 'Run `npm test -- --updateSnapshot`.'],
    ['Keep this:\n```js\nreturn 1;\n```', 'Keep this:\n```js\nreturn 1; doEvil();\n```'],
    ['Keep "no".', 'Keep "none".'],
    ['Keep `30`.', 'Keep `300`.'],
    ['Fix `src/a.ts`.', 'Fix `src/a.tsx`.'],
    ['Keep "no".', 'Keep no.'],
  ];
  for (const [input, output] of cases) {
    const result = verifyPrompt(input, output);
    assert.equal(result.status, 'issues', input);
    assert.equal(result.matchedCount, 0);
  }
  assert.equal(verifyPrompt('Run `npm test`.', 'Run this exact command:\n```sh\nnpm test\n```').status, 'pass');
  assert.equal(verifyPrompt('Keep "no".', 'Keep `no`.').status, 'pass');
  assert.equal(verifyPrompt('Run `npm test`.', 'The source command is `npm test`. Do not substitute `npm test -- --updateSnapshot`.').status, 'pass');
});

test('a later complete occurrence counts even after an earlier changed token', () => {
  assert.equal(verifyPrompt('Change src/main.ts.', 'Compare src/main.tsx against the original src/main.ts.').status, 'pass');
  assert.equal(verifyPrompt('Read https://example.test/a.', 'Do not use https://example.test/abc. Use https://example.test/a.').status, 'pass');
});

test('requested edits must still preserve original literal context', () => {
  const source = 'Rename `old_name` to `new_name`.';
  assert.equal(verifyPrompt(source, 'Rename the function to `new_name`.').status, 'issues');
  const result = verifyPrompt(source, 'Rename `old_name` to `new_name`.');
  assert.equal(result.status, 'pass');
  assert.equal(result.protectedCount, 2);
  assert.equal(result.matchedCount, 2);
  assert.equal(result.reviewRequired, true);
});

test('a pass is limited to mechanics and explicitly leaves semantics and STE unverified', () => {
  const result = verifyPrompt('Do not delete data.', 'Delete all data.');
  assert.equal(result.status, 'pass');
  assert.equal(result.reviewRequired, true);
  assert.equal(result.protectedCount, 0);
  assert.equal(result.checks.find(check => check.id === 'meaning-and-requirements').status, 'not-applicable');
  assert.equal(result.checks.find(check => check.id === 'full-ste-compliance').status, 'not-applicable');
  assert.equal(result.checks.find(check => check.id === 'protected-literals').status, 'not-applicable');
  for (const language of ['de', 'pl']) {
    assert.equal(verifyPrompt('Text', 'Text', language).checks.at(-1).id, 'english-ste-not-applicable');
  }
});

test('invalid outputs fail deterministically and are not scanned for protected literals', () => {
  for (const output of ['', ' \n\t ', null, {}, '\0', 'a'.repeat(64_001)]) {
    const result = verifyPrompt('Keep `important`.', output);
    assert.equal(result.status, 'issues');
    assert.equal(result.matchedCount, 0);
    assert.equal(result.reviewRequired, true);
    assert.equal(result.checks.find(check => check.id === 'protected-literals').status, 'not-applicable');
  }
  assert.equal(verifyPrompt('Text.', 'a'.repeat(64_000)).status, 'pass');
});

test('source size, type and null-character bounds are enforced before extraction', () => {
  assert.deepEqual(extractProtectedLiterals(''), []);
  assert.deepEqual(extractProtectedLiterals('a'.repeat(24_000)), []);
  assert.throws(() => extractProtectedLiterals('a'.repeat(24_001)), /24,000/);
  for (const input of [null, {}, 12, '\0']) assert.throws(() => extractProtectedLiterals(input), TypeError);
});

test('literal issue excerpts are bounded and do not execute untrusted source patterns', () => {
  const text = '$(touch /tmp/do-not-create) <script>alert(1)</script> ' + 'x'.repeat(1_000);
  const result = verifyPrompt('Keep `' + text + '`.', 'Different text.');
  assert.equal(result.status, 'issues');
  assert.equal(result.issues.length, 1);
  assert.ok(result.issues[0].excerpt.length <= 160);
  assert.ok(result.issues[0].excerpt.includes('$(touch /tmp/do-not-create)'));
});

test('worst-shape bounded source inputs finish without pathological delimiter backtracking', () => {
  const cases = ['“'.repeat(24_000), 'https://example.test/' + ')]}'.repeat(7_990), 'a'.repeat(24_000)];
  const started = performance.now();
  for (const input of cases) extractProtectedLiterals(input.slice(0, 24_000));
  assert.ok(performance.now() - started < 5_000, '24k source parsing must stay bounded');
});
