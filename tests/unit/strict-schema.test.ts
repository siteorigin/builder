import { describe, expect, it } from 'vitest';
import { decodeStrictValue, findForbiddenShapes, OPEN_VALUE_KEY, toStrictSchema, type JsonSchema } from '@agent/strict-schema';
import { TOOL_ARGS, toolDefinitions } from '@agent/tools';

const OPEN = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, { type: 'object', properties: { $json: { type: 'string' } }, required: ['$json'], additionalProperties: false }] };

/** Every schema node, following only the positions that hold schemas. */
function nodes(schema: JsonSchema): JsonSchema[] {
  const children = [...Object.values((schema.properties as Record<string, JsonSchema>) ?? {}), ...((schema.anyOf as JsonSchema[]) ?? []), ...((schema.oneOf as JsonSchema[]) ?? []), ...(schema.items ? [schema.items as JsonSchema] : [])];
  return [schema, ...children.flatMap(nodes)];
}

describe('toStrictSchema', () => {
  it.each([
    ['full tool set', { codeEnabled: true, definitionOps: true }],
    ['no code', { codeEnabled: false, definitionOps: false }],
    ['contract editing without code', { codeEnabled: false, definitionOps: true }]
  ])('emits no forbidden shape for any real tool (%s)', (_label, opts) => {
    const tools = toolDefinitions(opts);
    expect(tools.length).toBeGreaterThan(5);
    for (const tool of tools) {
      const strict = toStrictSchema(tool.parameters);
      expect(findForbiddenShapes(strict), tool.name).toEqual([]);
      for (const node of nodes(strict)) {
        expect(Object.keys(node).length === 0, `${tool.name}: empty object`).toBe(false);
        if (node.type === 'object') expect(node.additionalProperties, tool.name).toBe(false);
        expect(node).not.toHaveProperty('propertyNames');
        expect(node).not.toHaveProperty('oneOf');
      }
    }
  });

  it('keeps every offered operation as its own branch, with its open value encoded', () => {
    const apply = toolDefinitions({ codeEnabled: true, definitionOps: true }).find((t) => t.name === 'apply_operations')!;
    const strict = toStrictSchema(apply.parameters);
    const branches = ((strict.properties as Record<string, JsonSchema>).operations.items as JsonSchema).anyOf as JsonSchema[];
    const setProp = branches.find((b) => ((b.properties as Record<string, JsonSchema>).type.enum as string[])[0] === 'instance.setProp')!;
    expect(branches.length).toBeGreaterThan(20);
    expect((setProp.properties as Record<string, JsonSchema>).value).toEqual(OPEN);
  });

  it('no real tool declares the reserved key, so decoding can never rewrite a declared field', () => {
    for (const tool of toolDefinitions({ codeEnabled: true, definitionOps: true })) {
      const declared = nodes(tool.parameters).flatMap((n) => Object.keys((n.properties as object) ?? {}));
      expect(declared, tool.name).not.toContain(OPEN_VALUE_KEY);
    }
  });

  it('the checker catches each forbidden shape', () => {
    const closed = (properties: JsonSchema) => ({ type: 'object', properties, additionalProperties: false });
    expect(findForbiddenShapes(closed({ a: {} }))).toEqual(['$.a: empty schema', '$.a: no type']);
    expect(findForbiddenShapes({ type: 'object', properties: {}, additionalProperties: {} })[0]).toMatch(/not closed/);
    expect(findForbiddenShapes({ type: 'object', properties: {} })[0]).toMatch(/not closed/);
    expect(findForbiddenShapes({ type: 'object', additionalProperties: false })[0]).toMatch(/declares no properties/);
    expect(findForbiddenShapes(closed({ a: { type: 'array' } }))[0]).toMatch(/array without items/);
    for (const keyword of ['oneOf', 'allOf', 'not', 'if', 'then', 'else', '$ref', '$defs', 'definitions', 'propertyNames', 'patternProperties', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'pattern', 'format'])
      expect(findForbiddenShapes(closed({ a: { type: 'string', [keyword]: [] } })).join(), keyword).toContain(keyword);
    expect(findForbiddenShapes({ anyOf: [{ type: 'array', items: {} }] }, '#')).toEqual(['#.anyOf[0][]: empty schema', '#.anyOf[0][]: no type']);
    expect(findForbiddenShapes({ type: 'string', additionalProperties: false })).toEqual(['$: additionalProperties outside an object']);
    expect(findForbiddenShapes(true)).toEqual(['$: not a schema object']);
    expect(findForbiddenShapes({ enum: ['a'] })).toEqual([]);
  });

  it('closes objects and keeps declared fields, required lists and enums', () => {
    expect(toStrictSchema({ type: 'object', properties: { a: { type: 'string', minLength: 1, maxLength: 80 }, b: { enum: ['x', 'y'] }, c: { type: 'string', const: 'k' } }, required: ['a', 'ghost'] })).toEqual({
      type: 'object',
      properties: { a: { type: 'string', minLength: 1, maxLength: 80 }, b: { enum: ['x', 'y'] }, c: { type: 'string', enum: ['k'] } },
      required: ['a'],
      additionalProperties: false
    });
  });

  it('turns open values and records into the encoded form', () => {
    const strict = toStrictSchema({ type: 'object', properties: { any: {}, map: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} }, list: { type: 'array' } }, required: ['any'] });
    expect((strict.properties as JsonSchema).any).toEqual(OPEN);
    expect((strict.properties as JsonSchema).map).toEqual(OPEN.anyOf[4]);
    expect((strict.properties as JsonSchema).list).toEqual({ type: 'array', items: OPEN });
  });

  it('rewrites unions, nullable type lists, allOf and references', () => {
    expect(toStrictSchema({ oneOf: [{ type: 'string' }, { type: 'integer' }] })).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
    expect(toStrictSchema({ type: ['string', 'null'], maxLength: 10 })).toEqual({ anyOf: [{ type: 'string', maxLength: 10 }, { type: 'null' }] });
    expect(toStrictSchema({ allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'boolean' } }, required: ['b'] }] })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'boolean' } },
      required: ['a', 'b'],
      additionalProperties: false
    });
    expect(toStrictSchema({ type: 'object', properties: { a: { $ref: '#/$defs/name' } }, $defs: { name: { type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false });
  });

  it('ends a recursive reference at an open value, so the grammar stays finite', () => {
    const strict = toStrictSchema({ $ref: '#/$defs/tree', $defs: { tree: { type: 'object', properties: { child: { $ref: '#/$defs/tree' } } } } });
    expect(findForbiddenShapes(strict)).toEqual([]);
    expect((strict.properties as JsonSchema).child).toEqual(OPEN);
  });

  it('does not overflow on a reference cycle through allOf', () => {
    expect(toStrictSchema({ allOf: [{ $ref: '#' }] })).toEqual(OPEN);
  });

  it('treats a definition reused by siblings as a reuse, not a cycle', () => {
    const name = { $ref: '#/$defs/name' };
    expect(toStrictSchema({ type: 'object', properties: { a: name, b: name }, $defs: { name: { type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, additionalProperties: false });
  });

  it('resolves reference chains, escaped keys and sibling keywords', () => {
    expect(toStrictSchema({ $ref: '#/$defs/a~1b', $defs: { 'a/b': { $ref: '#/$defs/c~0d' }, 'c~d': { type: 'boolean' } } })).toEqual({ type: 'boolean' });
    expect(toStrictSchema({ $ref: '#/$defs/A', properties: { b: { type: 'string' } }, required: ['b'], $defs: { A: { type: 'object', properties: { a: { type: 'string' } } } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['b'],
      additionalProperties: false
    });
    expect(toStrictSchema({ $ref: '#/$defs/missing' })).toEqual(OPEN);
    expect(toStrictSchema({ $ref: 'https://example.com/schema.json' })).toEqual(OPEN);
  });

  it('distributes allOf over a union, so a closed branch keeps the shared fields', () => {
    const strict = toStrictSchema({ allOf: [{ type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }, { anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'object', properties: { c: { type: 'boolean' } } }] }] });
    expect(strict).toEqual({
      anyOf: [
        { type: 'object', properties: { b: { type: 'number' }, a: { type: 'string' } }, required: ['b', 'a'], additionalProperties: false },
        { type: 'object', properties: { b: { type: 'number' }, c: { type: 'boolean' } }, required: ['b'], additionalProperties: false }
      ]
    });
  });

  it('keeps a __proto__ property as data', () => {
    const strict = toStrictSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}'));
    expect(Object.keys(strict.properties as object)).toEqual(['__proto__']);
    expect(strict.required).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(strict.properties)).toBe(Object.prototype);
  });

  it('uses the encoded form for an object with a catchall, so its extra keys stay expressible', () => {
    expect(toStrictSchema({ type: 'object', properties: { tag: { type: 'string' } }, additionalProperties: { type: 'number' } })).toEqual(OPEN.anyOf[4]);
    expect(toStrictSchema({ properties: { a: { type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false });
  });

  it('keeps literals closed and within their declared type', () => {
    expect(findForbiddenShapes(toStrictSchema({ type: 'object', const: { a: 1 } }))).toEqual([]);
    expect(toStrictSchema({ type: 'object', const: { a: 1 } })).toEqual({ enum: [{ a: 1 }] });
    expect(toStrictSchema({ const: false })).toEqual({ enum: [false] });
    expect(toStrictSchema({ type: 'string', enum: ['x', 'y'] })).toEqual({ type: 'string', enum: ['x', 'y'] });
    expect(toStrictSchema({ type: ['string', 'null'], enum: ['a', null, 7] })).toEqual({ enum: ['a', null] });
  });

  it('offers a tuple its item types without excluding valid lengths', () => {
    expect(toStrictSchema({ type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } })).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } });
    expect(toStrictSchema({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'boolean' }], items: false, minItems: 2 })).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'boolean' }] }, minItems: 2, maxItems: 2 });
  });

  it('keeps grammar bounds up to the limit and drops them just above it', () => {
    expect(toStrictSchema({ type: 'string', minLength: 512, maxLength: 512 })).toEqual({ type: 'string', minLength: 512, maxLength: 512 });
    expect(toStrictSchema({ type: 'string', minLength: 513, maxLength: 513 })).toEqual({ type: 'string' });
    expect(toStrictSchema({ type: 'array', items: { type: 'string' }, minItems: 64, maxItems: 64 })).toEqual({ type: 'array', items: { type: 'string' }, minItems: 64, maxItems: 64 });
    expect(toStrictSchema({ type: 'array', items: { type: 'string' }, minItems: 65, maxItems: 65 })).toEqual({ type: 'array', items: { type: 'string' } });
    expect(toStrictSchema({ type: 'integer', minimum: 0, maximum: 1.5 })).toEqual({ type: 'integer', minimum: 0 });
    expect(toStrictSchema({ type: 'number', minimum: 0, maximum: 1 })).toEqual({ type: 'number' });
  });

  it('leaves out limits that would blow up a grammar, and patterns it cannot compile', () => {
    expect(toStrictSchema({ type: 'string', maxLength: 100000, pattern: '^a+$', format: 'email' })).toEqual({ type: 'string' });
    expect(toStrictSchema({ type: 'array', items: { type: 'string' }, maxItems: 5000, minItems: 1 })).toEqual({ type: 'array', items: { type: 'string' }, minItems: 1 });
  });

  it('does not modify its input', () => {
    const input = { allOf: [{ type: 'object', properties: { a: {} }, required: ['a', 'ghost'] }, { properties: { b: { type: 'string' } } }] };
    const copy = structuredClone(input);
    toStrictSchema(input);
    expect(input).toEqual(copy);
  });
});

describe('decodeStrictValue', () => {
  it('restores encoded values at any depth and leaves plain values alone', () => {
    const link = { type: 'page', target: 'pg_home' };
    expect(decodeStrictValue({ a: 'text', b: 3, c: null, d: [{ [OPEN_VALUE_KEY]: JSON.stringify(link) }], e: { value: { [OPEN_VALUE_KEY]: '[1,2]' } } })).toEqual({ a: 'text', b: 3, c: null, d: [link], e: { value: [1, 2] } });
  });

  it('does not decode twice, so content that looks encoded stays content', () => {
    const inner = JSON.stringify({ [OPEN_VALUE_KEY]: '"x"' });
    expect(decodeStrictValue({ [OPEN_VALUE_KEY]: inner })).toEqual({ [OPEN_VALUE_KEY]: '"x"' });
  });

  it('only treats a one-key object with a string as encoded', () => {
    expect(decodeStrictValue({ [OPEN_VALUE_KEY]: '42', label: 'keep' })).toEqual({ [OPEN_VALUE_KEY]: '42', label: 'keep' });
    expect(decodeStrictValue({ [OPEN_VALUE_KEY]: 42 })).toEqual({ [OPEN_VALUE_KEY]: 42 });
    expect(decodeStrictValue({ [OPEN_VALUE_KEY]: '[{"$json":"42"}]' })).toEqual([{ [OPEN_VALUE_KEY]: '42' }]);
  });

  it('throws on an encoded value that is not JSON', () => {
    expect(() => decodeStrictValue({ value: { [OPEN_VALUE_KEY]: '{broken' } })).toThrow(SyntaxError);
  });

  it('round-trips a real operation through the strict form into the tool validator', () => {
    const encoded = { expectedRevision: 2, operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: 'pg_a' }, nodeId: 'n_1', prop: 'cta', value: { [OPEN_VALUE_KEY]: JSON.stringify({ label: 'Go', link: { type: 'page', target: 'pg_b' } }) } }] };
    const parsed = TOOL_ARGS.apply_operations.parse(decodeStrictValue(encoded));
    expect(parsed.operations[0]).toEqual({ type: 'instance.setProp', owner: { kind: 'page', id: 'pg_a' }, nodeId: 'n_1', prop: 'cta', value: { label: 'Go', link: { type: 'page', target: 'pg_b' } } });
  });
});
