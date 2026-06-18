/**
 * Tool definition shape and validator.
 *
 * Borrowed from Pi (`@earendil-works/pi-ai`'s Tool type) and from the
 * Anthropic SDK's tool-use input schema. A finbot tool is the unit of
 * capability exposed to a subagent. It mirrors `skills/<name>/SKILL.md`
 * one-to-one but is the runtime-loadable form.
 *
 *   interface Tool {
 *     name: string;             // unique within a registry
 *     description: string;      // one-paragraph natural-language
 *     inputSchema: JSONSchema;  // JSON-schema-shaped object
 *     run: (args, ctx) => Promise<ToolResult>;
 *     skillPath?: string;       // for tools loaded from SKILL.md
 *     skillFrontmatter?: object;
 *   }
 *
 *   interface ToolResult {
 *     ok: boolean;
 *     content: Array<{ type: 'text', text: string } | { type: 'json', value: unknown }>;
 *     details?: unknown;
 *   }
 *
 * Validation is structural and forgiving: missing optional fields are
 * defaulted; unknown extra fields are preserved. A tool's `run` must be
 * a function; `name` must be a non-empty string; `description` and
 * `inputSchema` are required but accept any non-null value (the
 * registry caller is responsible for richer validation).
 */

export class ToolDefError extends Error {}

/**
 * @param {unknown} t
 * @returns {asserts t is import('../types.d.ts').Tool}
 */
export function assertToolDef(t) {
  if (t === null || typeof t !== 'object') {
    throw new ToolDefError('tool def must be an object');
  }
  const tool = /** @type {Record<string, unknown>} */ (t);
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new ToolDefError('tool.name must be a non-empty string');
  }
  if (typeof tool.description !== 'string') {
    throw new ToolDefError(`tool ${tool.name}: description must be a string`);
  }
  if (tool.inputSchema === null || typeof tool.inputSchema !== 'object') {
    throw new ToolDefError(`tool ${tool.name}: inputSchema must be an object`);
  }
  if (typeof tool.run !== 'function') {
    throw new ToolDefError(`tool ${tool.name}: run must be a function`);
  }
}

/**
 * Build a tool result. Throws if shape is wrong.
 *
 * @param {boolean} ok
 * @param {Array<{ type: 'text', text: string } | { type: 'json', value: unknown }>} content
 * @param {unknown} [details]
 */
export function toolResult(ok, content, details) {
  if (typeof ok !== 'boolean') {
    throw new ToolDefError('toolResult: ok must be boolean');
  }
  if (!Array.isArray(content)) {
    throw new ToolDefError('toolResult: content must be an array');
  }
  for (const item of content) {
    if (item === null || typeof item !== 'object') {
      throw new ToolDefError('toolResult.content item must be an object');
    }
    if (item.type !== 'text' && item.type !== 'json') {
      throw new ToolDefError(`toolResult.content type must be "text" or "json"; got ${item.type}`);
    }
  }
  return { ok, content, details };
}
