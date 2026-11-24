import { describe, expect, it } from 'vitest';
import { decodeStrictValue, dropEnumTypes, findForbiddenShapes, inlineDefinitions, OPEN_VALUE_KEY, shareDefinitions, toStrictSchema, type JsonSchema } from '@agent/strict-schema';
import { envelopeSchema } from '@agent/constrained';
import { constrainedToolSets } from './fixtures/constrained-tools';
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

describe('the compact wire schema (#364)', () => {
  const closed = (properties: JsonSchema, required?: string[]) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
  const image = closed({ assetId: { anyOf: [{ type: 'string' }, { type: 'null' }] }, alt: { type: 'string', maxLength: 300 } }, ['assetId', 'alt']);

  it('drops only the type beside an enum of strings', () => {
    const schema = closed({ a: { type: 'string', enum: ['x', 'y'] }, b: { type: 'integer', enum: [1, 2] }, c: { type: 'string', maxLength: 5 }, d: { type: 'array', items: { type: 'string', enum: ['z'] }, maxItems: 2 }, e: { enum: ['a', null] } });
    expect(dropEnumTypes(schema)).toEqual(closed({ a: { enum: ['x', 'y'] }, b: { type: 'integer', enum: [1, 2] }, c: { type: 'string', maxLength: 5 }, d: { type: 'array', items: { enum: ['z'] }, maxItems: 2 }, e: { enum: ['a', null] } }));
    expect(schema.properties.a).toEqual({ type: 'string', enum: ['x', 'y'] });
    // Only an enum of strings: a string type beside a mixed list stays.
    expect(dropEnumTypes({ type: 'string', enum: ['a', 1] })).toEqual({ type: 'string', enum: ['a', 1] });
  });

  it('writes a repeated subtree once and refers to it, and gives back exactly the input', () => {
    const schema = closed({ hero: image, logo: image, portrait: image, name: { type: 'string' } });
    const shared = shareDefinitions(schema);
    expect(Object.keys(shared.$defs as object)).toEqual(['d0']);
    expect((shared.properties as JsonSchema).logo).toEqual({ $ref: '#/$defs/d0' });
    expect((shared.properties as JsonSchema).name).toEqual({ type: 'string' });
    expect(JSON.stringify(shared).length).toBeLessThan(JSON.stringify(schema).length);
    expect(findForbiddenShapes(shared)).toEqual([]);
    expect(inlineDefinitions(shared)).toEqual(schema);
    // A small subtree costs more as a reference than written out.
    const small = closed({ a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } });
    expect(shareDefinitions(small)).toEqual(small);
    // Nor is it shared when the `$defs` wrapper would make the whole larger.
    const bounded = { type: 'string', maxLength: 1 };
    const four = closed({ a: bounded, b: bounded, c: bounded, d: bounded });
    expect(shareDefinitions(four)).toBe(four);
  });

  it('never names a definition like a root property, whose rule older llama.cpp would use instead', () => {
    const long = { enum: ['x'.repeat(80)] };
    const shared = shareDefinitions(closed({ d0: { enum: ['wrong'] }, x: long, y: long }));
    expect(Object.keys(shared.$defs as object)).toEqual(['d1']);
    expect((shared.properties as JsonSchema).x).toEqual({ $ref: '#/$defs/d1' });
  });

  it('shares nested repeats inside a shared subtree only when they still repeat', () => {
    const card = closed({ image, caption: { type: 'string' } });
    const shared = shareDefinitions(closed({ a: card, b: card, c: image }));
    expect(inlineDefinitions(shared)).toEqual(closed({ a: card, b: card, c: image }));
    expect(findForbiddenShapes(shared)).toEqual([]);
    // The image repeats once the card is shared (inside the card's definition, and on its own), so both are shared.
    const defs = Object.values(shared.$defs as Record<string, JsonSchema>).map((d) => JSON.stringify(d));
    expect(defs).toContain(JSON.stringify(image));
    expect(defs.some((d) => d.includes('"caption"'))).toBe(true);
    // Without the lone image, only the card is.
    const cardsOnly = shareDefinitions(closed({ a: card, b: card }));
    expect(Object.values(cardsOnly.$defs as Record<string, JsonSchema>).map((d) => JSON.stringify(d))).toEqual([JSON.stringify(card)]);
  });

  it('keeps a __proto__ property as data when sharing and inlining', () => {
    const odd = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string","maxLength":300},"x":{"type":"string","maxLength":300}},"additionalProperties":false}');
    const schema = closed({ a: odd, b: odd, c: odd });
    const shared = shareDefinitions(schema);
    expect(Object.keys(((shared.$defs as Record<string, JsonSchema>).d0.properties as object))).toEqual(['__proto__', 'x']);
    const back = inlineDefinitions(shared);
    expect(back).toEqual(schema);
    expect(Object.keys(((back.properties as JsonSchema).a as JsonSchema).properties as object)).toEqual(['__proto__', 'x']);
  });

  it('round-trips every envelope a constrained run sends', () => {
    for (const { label, tools } of constrainedToolSets()) {
      const inline = envelopeSchema(tools);
      const compact = envelopeSchema(tools, { compact: true });
      expect(findForbiddenShapes(inline), label).toEqual([]);
      expect(findForbiddenShapes(compact), label).toEqual([]);
      expect(inlineDefinitions(compact), label).toEqual(dropEnumTypes(inline));
      expect(JSON.stringify(compact).length, label).toBeLessThan(JSON.stringify(inline).length);
    }
  });

  it('accepts root definitions only as lone local references to plain names', () => {
    const ok = { ...closed({ a: { $ref: '#/$defs/d0' } }), $defs: { d0: { type: 'string' } } };
    expect(findForbiddenShapes(ok)).toEqual([]);
    expect(findForbiddenShapes({ ...closed({ a: { $ref: '#/$defs/d1' } }), $defs: { d0: { type: 'string' } } })).toEqual(['$.a: reference to a missing definition d1']);
    expect(findForbiddenShapes({ ...closed({ a: { $ref: '#/$defs/d0', type: 'string' } }), $defs: { d0: { type: 'string' } } })).toContain('$.a: forbidden keyword $ref');
    expect(findForbiddenShapes({ ...closed({ a: { $ref: '#/definitions/d0' } }), $defs: { d0: { type: 'string' } } })).toContain('$.a: forbidden keyword $ref');
    expect(findForbiddenShapes({ ...closed({ a: { $ref: '#/$defs/name' } }), $defs: { name: { type: 'string' } } })).toContain('$.$defs.name: definition name is not plain');
    expect(findForbiddenShapes({ ...closed({ a: { $ref: '#/$defs/d0extra' } }), $defs: { d0extra: { type: 'string' } } })).toContain('$.$defs.d0extra: definition name is not plain');
    // Only what shareDefinitions writes: no definition that is only a reference, and no root that is one.
    expect(findForbiddenShapes({ ...closed({ a: { $ref: '#/$defs/d0' } }), $defs: { d0: { $ref: '#/$defs/d1' }, d1: { enum: ['yes'] } } })).toEqual(['$.$defs.d0: definition is only a reference']);
    expect(findForbiddenShapes({ $ref: '#/$defs/d0', $defs: { d0: { enum: ['yes'] } } })).toEqual(['$: the root is only a reference']);
    expect(findForbiddenShapes({ ...closed({ a: { $ref: '#/$defs/d0' } }), $defs: { d0: closed({ b: { $ref: '#/$defs/d1' } }), d1: closed({ c: { $ref: '#/$defs/d0' } }) } })).toEqual(['$.$defs.d0: definition refers to itself', '$.$defs.d1: definition refers to itself']);
    expect(findForbiddenShapes({ ...closed({ a: { $ref: '#/$defs/d0' } }), $defs: { d0: { type: 'object', properties: {} } } })).toEqual(['$.$defs.d0: object is not closed']);
    expect(findForbiddenShapes({ ...closed({ a: { type: 'string' } }), $defs: [] })[0]).toMatch(/not a set of definitions/);
    // Nowhere but the root.
    expect(findForbiddenShapes(closed({ a: { ...closed({ b: { $ref: '#/$defs/d0' } }), $defs: { d0: { type: 'string' } } } })).join()).toContain('forbidden keyword $defs');
    expect(findForbiddenShapes(closed({ a: { $ref: '#/$defs/d0' } })).join()).toContain('forbidden keyword $ref');
    expect(() => inlineDefinitions({ ...closed({ a: { $ref: '#/$defs/d0' } }), $defs: { d0: closed({ b: { $ref: '#/$defs/d0' } }) } })).toThrow(/Cannot inline/);
  });

  it('never sends a description or title, while a field named so survives', () => {
    const strict = toStrictSchema({
      type: 'object',
      title: 'Args',
      description: 'The arguments',
      properties: { description: { type: 'string', description: 'Shown under the title' }, title: { type: 'object', title: 'Nested', properties: { text: { type: 'string', description: 'x' } }, description: 'y' } }
    });
    expect(strict).toEqual(closed({ description: { type: 'string' }, title: closed({ text: { type: 'string' } }) }));
    for (const { label, tools } of constrainedToolSets()) {
      const wire = JSON.stringify(envelopeSchema(tools, { compact: true }));
      expect(wire, label).not.toMatch(/"(?:description|title)":"/);
    }
  });
});
