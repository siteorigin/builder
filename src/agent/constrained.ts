/**
 * The constrained-JSON wire format. The model answers every turn with one object,
 * `{ brief_status, action: { tool, args } }`, whose schema a grammar enforces token by token. The adapter maps
 * it onto an ordinary tool call, so scope checks, validation and undo are the same as for any provider.
 */
import type { ToolDefinition } from './types';
import { decodeStrictValue, dropEnumTypes, OPEN_VALUE_KEY, shareDefinitions, toStrictSchema, type JsonSchema } from './strict-schema';
import { SIGNATURE_LEGEND, signatures } from './signature';

export { signature } from './signature';

/** The action that ends the run's turn loop. It is not a tool: the adapter turns it into a final answer. */
export const FINISH_ACTION = 'finish';
const STATUS_LIMIT = 160;

function actionBranch(tool: string, args: JsonSchema): JsonSchema {
  return { type: 'object', properties: { tool: { type: 'string', enum: [tool] }, args }, required: ['tool', 'args'], additionalProperties: false };
}

const FINISH_ARGS: JsonSchema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false };

/**
 * The strict response schema for a set of tools. `compact` is the same grammar in fewer bytes, for a server that
 * follows local references: no type beside an enum of strings, and each repeated subtree written once under `$defs`.
 */
export function envelopeSchema(tools: ToolDefinition[], opts: { compact?: boolean } = {}): JsonSchema {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      brief_status: { type: 'string', maxLength: STATUS_LIMIT },
      action: { anyOf: [...tools.map((t) => actionBranch(t.name, toStrictSchema(t.parameters))), actionBranch(FINISH_ACTION, FINISH_ARGS)] }
    },
    required: ['brief_status', 'action'],
    additionalProperties: false
  };
  return opts.compact ? shareDefinitions(dropEnumTypes(schema)) : schema;
}

/**
 * Instructions added to the system prompt, since the tools are not sent in the native format. Each tool is its
 * signature and its brief: the system prompt above it does not describe the tools again.
 */
export function envelopeInstructions(tools: ToolDefinition[]): string {
  const { types, tools: sigs } = signatures(tools.map((t) => toStrictSchema(t.parameters)));
  const open = [...types, ...sigs].some((s) => /(?<![\w-])json(?![\w-])|json-object/.test(s));
  const lines = tools.map((t, i) => {
    const about = t.brief ?? t.description;
    return `- ${t.name} ${sigs[i]}${about ? `\n  ${about}` : ''}`;
  });
  return `

Reply with one JSON object only: {"brief_status":"<a few words on what you are doing>","action":{"tool":"<name>","args":{…}}}
One tool call per reply, whatever the text above says; its result comes next. When the request is done, call "${FINISH_ACTION}" with {"message":"<one or two plain sentences: what changed, or the answer or advice asked for>"}.
${SIGNATURE_LEGEND}${open ? ` A json field takes a string, number, boolean or null as it is; an object or array goes in as {"${OPEN_VALUE_KEY}":"<its JSON text>"}, as a json-object field always does.` : ''}
${types.length ? `Types:\n${types.join('\n')}\n` : ''}Tools:
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
