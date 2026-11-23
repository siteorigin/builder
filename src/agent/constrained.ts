/**
 * The constrained-JSON wire format. The model answers every turn with one object,
 * `{ brief_status, action: { tool, args } }`, whose schema a grammar enforces token by token. The adapter maps
 * it onto an ordinary tool call, so scope checks, validation and undo are the same as for any provider.
 */
import type { ToolDefinition } from './types';
import { decodeStrictValue, OPEN_VALUE_KEY, toStrictSchema, type JsonSchema } from './strict-schema';

/** The action that ends the run's turn loop. It is not a tool: the adapter turns it into a final answer. */
export const FINISH_ACTION = 'finish';
const STATUS_LIMIT = 160;

function actionBranch(tool: string, args: JsonSchema): JsonSchema {
  return { type: 'object', properties: { tool: { type: 'string', enum: [tool] }, args }, required: ['tool', 'args'], additionalProperties: false };
}

const FINISH_ARGS: JsonSchema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false };

/** The strict response schema for a set of tools. */
export function envelopeSchema(tools: ToolDefinition[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      brief_status: { type: 'string', maxLength: STATUS_LIMIT },
      action: { anyOf: [...tools.map((t) => actionBranch(t.name, toStrictSchema(t.parameters))), actionBranch(FINISH_ACTION, FINISH_ARGS)] }
    },
    required: ['brief_status', 'action'],
    additionalProperties: false
  };
}

/** A compact signature for a strict schema; a grammar constrains the output but the model never sees it. */
export function signature(schema: JsonSchema): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join('|');
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    if (branches.some(isOpenObject)) return 'json';
    return branches.map(signature).join(' | ');
  }
  if (isOpenObject(schema)) return 'json-object';
  if (schema.type === 'array') {
    const inner = signature(schema.items as JsonSchema);
    return inner.includes('|') ? `(${inner})[]` : `${inner}[]`;
  }
  if (schema.type === 'object') {
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const fields = Object.entries(schema.properties as Record<string, JsonSchema>).map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${signature(v)}`);
    return `{${fields.join(', ')}}`;
  }
  return String(schema.type);
}

function isOpenObject(schema: JsonSchema): boolean {
  const props = schema.properties as Record<string, unknown> | undefined;
  return schema.type === 'object' && !!props && Object.keys(props).length === 1 && OPEN_VALUE_KEY in props;
}

/** Instructions added to the system prompt, since the tools are not sent in the native format. */
export function envelopeInstructions(tools: ToolDefinition[]): string {
  const lines = tools.map((t) => `- ${t.name} ${signature(toStrictSchema(t.parameters))}\n  ${t.description}`);
  return `

Response format (this overrides anything above about calling several tools in a turn):
Reply with exactly one JSON object and nothing else:
{"brief_status":"<a few words on what you are doing>","action":{"tool":"<tool name>","args":{...}}}
Each reply makes exactly one tool call; you get its result in the next message.
When the whole request is done, use the tool "${FINISH_ACTION}" with args {"message":"<one or two plain sentences saying what changed>"}.
A field typed "json" takes a plain string, number, boolean or null directly. An object or array goes in as {"${OPEN_VALUE_KEY}":"<the value encoded as a JSON string>"}. A field typed "json-object" always uses that form.

Tools:
${lines.join('\n')}`;
}

/** `wire` is the validated object as canonical JSON, which is what later turns replay. */
export type ParsedEnvelope = { ok: true; status: string; finish: string | null; tool: string; args: string; wire: string } | { ok: false; problem: string };

/** Reasoning some models put before their answer, whether or not the opening tag was part of the output. */
export function stripThinking(text: string): string {
  return text.replace(/^\s*(?:<think>)?[\s\S]*?<\/think>\s*/, '');
}

/**
 * Read a model reply. A server that ignores the grammar may add a closed reasoning block or a code fence
 * around the whole object. Nothing is searched for inside other text: a draft in unfinished reasoning must
 * never run as an action.
 */
export function parseEnvelope(raw: string): ParsedEnvelope {
  // Only a closed block at the very start is reasoning; the tag may also appear inside the object's strings.
  const body = raw.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim();
  const text = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(body)?.[1] ?? body;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'it was not a single valid JSON object' };
  }
  const env = value as { brief_status?: unknown; action?: { tool?: unknown; args?: unknown } } | null;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { ok: false, problem: 'it was not a JSON object' };
  if (typeof env.brief_status !== 'string') return { ok: false, problem: 'it had no brief_status' };
  const tool = env.action?.tool;
  if (typeof tool !== 'string' || !tool) return { ok: false, problem: 'it had no action.tool' };
  const args = env.action?.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, problem: 'action.args was not an object' };
  const status = env.brief_status;
  const wire = JSON.stringify(env);
  if (tool === FINISH_ACTION) {
    const message = (args as { message?: unknown }).message;
    if (typeof message !== 'string' || !message.trim()) return { ok: false, problem: `the "${FINISH_ACTION}" action had no message` };
    return { ok: true, status, finish: message, tool, args: '{}', wire };
  }
  try {
    return { ok: true, status, finish: null, tool, args: JSON.stringify(decodeStrictValue(args)), wire };
  } catch {
    return { ok: false, problem: `a "${OPEN_VALUE_KEY}" value was not valid JSON` };
  }
}

/** The status text of a reply still being generated, so the chat can show it before the action is complete. */
export function partialStatus(buffer: string): { text: string; complete: boolean } | null {
  const m = /^\s*\{\s*"brief_status"\s*:\s*"((?:[^"\\]|\\[\s\S])*)("?)/.exec(buffer);
  if (!m) return null;
  const safe = m[1].replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
  try {
    return { text: JSON.parse(`"${safe}"`) as string, complete: m[2] === '"' };
  } catch {
    return null;
  }
}
