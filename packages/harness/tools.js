/**
 * Tool registry + skill loader.
 *
 * The harness exposes a tool surface that mirrors the contents of
 * `skills/<name>/SKILL.md`. Each SKILL.md becomes a `Tool` entry whose
 * `description` is the SKILL.md prose (the agent reads it on demand) and
 * whose `run` is the stub procedure (for v0, a no-op that returns the
 * loaded SKILL.md path so the dispatching subagent can read its
 * procedure). When a SKILL.md grows an executable counterpart under
 * `scripts/<name>/`, the registry can bind `run` to that script; until
 * then the LLM-shaped subagent reads the SKILL.md prose and acts.
 *
 * SKILL.md frontmatter (when present) is parsed for tool metadata:
 *
 *   ---
 *   created: <date>
 *   updated: <date>
 *   author: <role>
 *   tool:
 *     name: <override-name>
 *     description: <one-line override>
 *     inputSchema:
 *       <inline schema>
 *   ---
 *
 * Without a `tool:` block, defaults derive from the skill name and the
 * first prose paragraph: the name is `skills/<name>`'s leaf, and the
 * description is the SKILL.md's first paragraph after the H1.
 *
 * Borrowing from Pi: `Tool` shape (`{ name, description, inputSchema, run }`)
 * mirrors `@earendil-works/pi-ai`'s tool type and Anthropic's tool-use schema.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { assertToolDef, toolResult, ToolDefError } from './schemas/tool.js';

/**
 * Load every `skills/<name>/SKILL.md` under `skillsDir` as a tool. Returns a
 * registry: an object keyed by tool name with `assertToolDef`-validated
 * entries.
 *
 * @param {string} skillsDir absolute path to the `skills/` directory.
 * @returns {Promise<Record<string, import('./schemas/tool.js').Tool>>}
 */
export async function loadTools(skillsDir) {
  const registry = {};
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return registry;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const skillMdPath = path.join(skillsDir, skillName, 'SKILL.md');
    let raw;
    try {
      raw = await fs.readFile(skillMdPath, 'utf8');
    } catch {
      // skill directories without SKILL.md are tolerated (placeholders)
      continue;
    }
    const tool = buildToolFromSkill(skillName, skillMdPath, raw);
    assertToolDef(tool);
    if (registry[tool.name]) {
      throw new ToolDefError(`tool name collision: ${tool.name} from ${skillMdPath} and ${registry[tool.name].skillPath}`);
    }
    registry[tool.name] = tool;
  }
  return registry;
}

/**
 * Parse a SKILL.md into a Tool.
 *
 * @param {string} skillName
 * @param {string} skillPath
 * @param {string} raw
 * @returns {import('./schemas/tool.js').Tool}
 */
export function buildToolFromSkill(skillName, skillPath, raw) {
  const { frontmatter, body } = splitFrontmatter(raw);
  const toolBlock = frontmatter.tool || {};
  const name = toolBlock.name || skillName;
  const description = toolBlock.description || firstParagraph(body) || `Skill: ${skillName}`;
  const inputSchema = toolBlock.inputSchema || { type: 'object', properties: {}, additionalProperties: true };
  return {
    name,
    description,
    inputSchema,
    skillPath,
    skillFrontmatter: frontmatter,
    run: async (args, ctx) => {
      // v0: skill bodies are not executable from the harness. Return the
      // skill path and procedure-shaped pointer; the calling subagent is
      // an LLM-shaped agent that reads SKILL.md and acts on its
      // procedure. When `scripts/<skillName>/` lands an executable, the
      // builder swaps this default `run` for a real implementation.
      return toolResult(true, [
        { type: 'text', text: `Skill ${name} is documentation-only in v0. Read ${skillPath}.` },
        { type: 'json', value: { skillPath, name, args, ctx: ctx ? Object.keys(ctx) : [] } },
      ], { v0: true });
    },
  };
}

/**
 * @param {string} raw
 * @returns {{ frontmatter: Record<string, any>, body: string }}
 */
export function splitFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) return { frontmatter: {}, body: raw };
  const fmText = raw.slice(4, end);
  const body = raw.slice(end + 5);
  return { frontmatter: parseFrontmatter(fmText), body };
}

/**
 * Minimal YAML-ish frontmatter parser. Handles flat key:value and one
 * level of nested key:value (e.g. `tool:` block). Sufficient for the
 * SKILL.md shape the garden uses; not a general YAML parser.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseFrontmatter(text) {
  const out = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith('#')) {
      i += 1;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const valueText = m[2];
    if (valueText.length > 0) {
      out[key] = coerceScalar(valueText);
      i += 1;
      continue;
    }
    // nested block; consume indented continuation
    const nested = {};
    i += 1;
    while (i < lines.length && /^\s+\S/.test(lines[i])) {
      const child = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (child) {
        nested[child[1]] = child[2].length > 0 ? coerceScalar(child[2]) : null;
      }
      i += 1;
    }
    out[key] = nested;
  }
  return out;
}

/**
 * @param {string} v
 */
export function coerceScalar(v) {
  const trimmed = v.trim();
  if (trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * @param {string} body
 * @returns {string}
 */
export function firstParagraph(body) {
  const trimmed = body.replace(/^# .*\n+/, '').trim();
  const para = trimmed.split('\n\n')[0];
  return (para || '').replace(/\s+/g, ' ').trim();
}

/**
 * Filter a registry to a named subset (e.g. for a role's allowed tools).
 *
 * @param {Record<string, import('./schemas/tool.js').Tool>} registry
 * @param {string[]} names
 */
export function selectTools(registry, names) {
  const subset = {};
  for (const name of names) {
    if (registry[name]) subset[name] = registry[name];
  }
  return subset;
}

/**
 * Render a registry as the Anthropic-shaped tool list (input for LLMs
 * that support tool use).
 *
 * @param {Record<string, import('./schemas/tool.js').Tool>} registry
 */
export function toolsToLlmShape(registry) {
  return Object.values(registry).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
