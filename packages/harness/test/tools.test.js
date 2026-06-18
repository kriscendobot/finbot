/**
 * Tool registry tests.
 *
 * Covers SKILL.md loading, frontmatter parsing, tool registry filtering,
 * and the LLM-shape rendering.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildToolFromSkill,
  coerceScalar,
  firstParagraph,
  loadTools,
  parseFrontmatter,
  selectTools,
  splitFrontmatter,
  toolsToLlmShape,
} from '../tools.js';

test('splitFrontmatter: empty body and frontmatter', () => {
  const r = splitFrontmatter('---\nfoo: bar\n---\nbody\n');
  assert.equal(r.frontmatter.foo, 'bar');
  assert.equal(r.body, 'body\n');
});

test('splitFrontmatter: no frontmatter', () => {
  const r = splitFrontmatter('plain body\n');
  assert.deepEqual(r.frontmatter, {});
  assert.equal(r.body, 'plain body\n');
});

test('parseFrontmatter: nested block', () => {
  const fm = parseFrontmatter('foo: bar\ntool:\n  name: my-tool\n  description: a tool\n');
  assert.equal(fm.foo, 'bar');
  assert.deepEqual(fm.tool, { name: 'my-tool', description: 'a tool' });
});

test('coerceScalar: numbers and booleans', () => {
  assert.equal(coerceScalar('42'), 42);
  assert.equal(coerceScalar('3.14'), 3.14);
  assert.equal(coerceScalar('true'), true);
  assert.equal(coerceScalar('false'), false);
  assert.equal(coerceScalar('null'), null);
  assert.equal(coerceScalar('hello'), 'hello');
  assert.equal(coerceScalar('"quoted"'), 'quoted');
});

test('firstParagraph: strips H1 and returns first paragraph', () => {
  const body = '# Skill: foo\n\nThis is the first paragraph.\n\nSecond para.\n';
  assert.equal(firstParagraph(body), 'This is the first paragraph.');
});

test('buildToolFromSkill: defaults + frontmatter override', () => {
  const raw = '---\ncreated: 2026-06-18\ntool:\n  name: my-override\n  description: override description\n---\n# Skill: foo\n\nA paragraph.\n';
  const t = buildToolFromSkill('foo', '/tmp/foo/SKILL.md', raw);
  assert.equal(t.name, 'my-override');
  assert.equal(t.description, 'override description');
  assert.equal(typeof t.run, 'function');
});

test('buildToolFromSkill: defaults from skill name + first paragraph', () => {
  const raw = '---\ncreated: 2026-06-18\n---\n# Skill: foo\n\nA paragraph about foo.\n';
  const t = buildToolFromSkill('foo', '/tmp/foo/SKILL.md', raw);
  assert.equal(t.name, 'foo');
  assert.equal(t.description, 'A paragraph about foo.');
});

test('loadTools: discovers SKILL.md files in skill dirs', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'finbot-tools-'));
  try {
    await mkdir(path.join(tmp, 'foo'), { recursive: true });
    await writeFile(path.join(tmp, 'foo', 'SKILL.md'), '---\ncreated: 2026-06-18\n---\n# Skill: foo\n\nfoo paragraph.\n');
    await mkdir(path.join(tmp, 'bar'), { recursive: true });
    await writeFile(path.join(tmp, 'bar', 'SKILL.md'), '---\n---\n# Skill: bar\n\nbar paragraph.\n');
    await mkdir(path.join(tmp, 'no-skill'), { recursive: true });
    const tools = await loadTools(tmp);
    assert.equal(Object.keys(tools).length, 2);
    assert.ok(tools.foo);
    assert.ok(tools.bar);
    assert.equal(tools.foo.description, 'foo paragraph.');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('loadTools: missing skills dir returns empty registry', async () => {
  const tools = await loadTools('/nonexistent-path');
  assert.deepEqual(tools, {});
});

test('selectTools: filters to named subset', () => {
  const registry = {
    a: { name: 'a' },
    b: { name: 'b' },
    c: { name: 'c' },
  };
  const subset = selectTools(registry, ['a', 'c', 'nonexistent']);
  assert.deepEqual(Object.keys(subset).sort(), ['a', 'c']);
});

test('toolsToLlmShape: renders Anthropic-compatible shape', () => {
  const registry = {
    foo: { name: 'foo', description: 'desc', inputSchema: { type: 'object' }, run: () => {} },
  };
  const shape = toolsToLlmShape(registry);
  assert.deepEqual(shape, [{ name: 'foo', description: 'desc', input_schema: { type: 'object' } }]);
});

test('tool.run: v0 returns documentation pointer', async () => {
  const raw = '---\n---\n# Skill: foo\n\nA paragraph.\n';
  const t = buildToolFromSkill('foo', '/tmp/foo/SKILL.md', raw);
  const r = await t.run({ arg: 1 }, { role: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.content[0].type, 'text');
  assert.match(r.content[0].text, /Skill foo is documentation-only/);
  assert.equal(r.content[1].value.skillPath, '/tmp/foo/SKILL.md');
});
