/**
 * @finbot/harness/providers — real LLM providers for the spawn `llm` hook.
 *
 * The harness ships a deterministic stub LLM as the default (see `spawn.js`);
 * these are the real, inference-driven alternatives a caller injects when it
 * wants a subagent to actually reason. Each provider's factory returns an `llm`
 * function matching the `spawn({ ..., llm })` contract. Nothing here touches the
 * network unless the returned function is invoked with a configured API key.
 */

export { makeAnthropicLlm, toAnthropicMessages, toAnthropicToolList, fromAnthropicResponse } from './anthropic.js';
