import { describe, expect, it } from 'vitest';
import { signature, signatures } from '@agent/signature';
import { envelopeInstructions } from '@agent/constrained';
import { OPEN_VALUE_KEY, toStrictSchema, type JsonSchema } from '@agent/strict-schema';
import { constrainedToolSets } from './fixtures/constrained-tools';

/**
 * What a schema says to a model reading its signature: fields with their requiredness and types, allowed values and
 * list shapes. Length limits are left to the grammar and the app's validation, so they are not part of it.
 */
type Shape =
  | { kind: 'object'; fields: Array<{ name: string; required: boolean; type: Shape }> }
  | { kind: 'array'; items: Shape }
  | { kind: 'prim'; name: string }
  | { kind: 'union'; members: Shape[] }
  | { kind: 'values'; values: unknown[] };

/** A union with its nested unions and allowed values flattened, in order, and a single member unwrapped. */
function union(members: Shape[]): Shape {
  const out: Shape[] = [];
  for (const m of members.flatMap((x) => (x.kind === 'union' ? x.members : [x]))) {
    const last = out[out.length - 1];
    if (m.kind === 'values' && last?.kind === 'values') last.values = [...last.values, ...m.values];
    else out.push(m.kind === 'values' ? { kind: 'values', values: [...m.values] } : m);
  }
  return out.length === 1 ? out[0] : { kind: 'union', members: out };
}

const isOpen = (s: JsonSchema) => s.type === 'object' && Object.keys((s.properties as object) ?? {}).join() === OPEN_VALUE_KEY;

function fromSchema(s: JsonSchema): Shape {
  if (Array.isArray(s.enum)) return { kind: 'values', values: s.enum };
  if (Array.isArray(s.anyOf)) return (s.anyOf as JsonSchema[]).some(isOpen) ? { kind: 'prim', name: 'json' } : union((s.anyOf as JsonSchema[]).map(fromSchema));
  if (isOpen(s)) return { kind: 'prim', name: 'json-object' };
  if (s.type === 'array') return { kind: 'array', items: fromSchema(s.items as JsonSchema) };
  if (s.type === 'object') {
    const required = new Set((s.required as string[]) ?? []);
    return { kind: 'object', fields: Object.entries(s.properties as Record<string, JsonSchema>).map(([name, v]) => ({ name, required: required.has(name), type: fromSchema(v) })) };
  }
  return { kind: 'prim', name: s.type === 'integer' ? 'int' : s.type === 'boolean' ? 'bool' : String(s.type) };
}

const PRIMS = new Set(['string', 'int', 'number', 'bool', 'null', 'json', 'json-object']);

/** Reads the notation back, as a model would have to: the named types, then each tool's signature. */
class Reader {
  private defs = new Map<string, () => Shape>();
  private text = '';
  private at = 0;

  constructor(types: string[]) {
    for (const line of types) {
      const name = /^([A-Za-z]\w*)=/.exec(line)![1];
      const body = line.slice(name.length + 1);
      const table = /^one of these, by ([^!]+)!(?:, each then with (.*?))?:\n([\s\S]*)$/.exec(body);
      let memo: Shape | undefined;
      this.defs.set(name, () => {
        if (memo) return memo;
        if (!table) return (memo = this.parse(body));
        const [, field, shared, rows] = table;
        const lead = shared ? (this.parse(`{${shared}}`) as Extract<Shape, { kind: 'object' }>).fields : [];
        memo = union(
          rows.split('\n').map((row) => {
            const [value, rest] = [row.slice(0, row.indexOf(' ')), row.slice(row.indexOf(' ') + 1)];
            const fields = (this.parse(rest) as Extract<Shape, { kind: 'object' }>).fields;
            return { kind: 'object' as const, fields: [{ name: field, required: true, type: { kind: 'values' as const, values: [value] } }, ...lead, ...fields] };
          })
        );
        return memo;
      });
    }
  }

  parse(text: string): Shape {
    const saved = [this.text, this.at] as const;
    this.text = text;
    this.at = 0;
    const out = this.union();
    expect(this.at, `trailing text in ${text}`).toBe(text.length);
    [this.text, this.at] = saved;
    return out;
  }

  private union(): Shape {
    const members = [this.postfix()];
    while (this.text[this.at] === '|') {
      this.at++;
      members.push(this.postfix());
    }
    return union(members);
  }

  private postfix(): Shape {
    let s = this.primary();
    while (this.text.startsWith('[]', this.at)) {
      this.at += 2;
      s = { kind: 'array', items: s };
    }
    return s;
  }

  private primary(): Shape {
    const c = this.text[this.at];
    if (c === '(') {
      this.at++;
      const inner = this.union();
      expect(this.text[this.at++]).toBe(')');
      return inner;
    }
    if (c === '{') return this.object();
    if (c === '"') return { kind: 'values', values: [this.quoted()] };
    const word = this.word();
    if (PRIMS.has(word)) return { kind: 'prim', name: word };
    if (this.defs.has(word)) return this.defs.get(word)!();
    if (/^-?\d/.test(word) || word === 'true' || word === 'false') return { kind: 'values', values: [JSON.parse(word)] };
    return { kind: 'values', values: [word] };
  }

  private object(): Shape {
    this.at++;
    const fields: Array<{ name: string; required: boolean; type: Shape }> = [];
    while (this.text[this.at] !== '}') {
      if (this.text.startsWith('...', this.at)) {
        this.at += 3;
        const spread = this.defs.get(this.word())!();
        expect(spread.kind).toBe('object');
        fields.push(...(spread as Extract<Shape, { kind: 'object' }>).fields);
      } else {
        const name = this.text[this.at] === '"' ? (this.quoted() as string) : this.word();
        const required = this.text[this.at] === '!';
        if (required) this.at++;
        let type: Shape = { kind: 'prim', name: 'string' };
        if (this.text[this.at] === ':') {
          this.at++;
          type = this.union();
        }
        fields.push({ name, required, type });
      }
      if (this.text[this.at] === ',') this.at++;
    }
    this.at++;
    return { kind: 'object', fields };
  }

  private word(): string {
    const m = /^[\w.\-/]+/.exec(this.text.slice(this.at))!;
    this.at += m[0].length;
    return m[0];
  }

  private quoted(): unknown {
    const m = /^"(?:[^"\\]|\\.)*"/.exec(this.text.slice(this.at))!;
    this.at += m[0].length;
    return JSON.parse(m[0]);
  }
}

/** Every signature read back says exactly what its schema does. */
function expectFaithful(schemas: JsonSchema[], label = '') {
  const { types, tools } = signatures(schemas);
  const reader = new Reader(types);
  schemas.forEach((s, i) => expect(reader.parse(tools[i]), `${label} ${tools[i].slice(0, 60)}`).toEqual(fromSchema(s)));
}

const obj = (properties: Record<string, JsonSchema>, required: string[] = []) => toStrictSchema({ type: 'object', properties, required });

describe('signatures (#364)', () => {
  it('writes optional strings bare, marks required fields, and types the rest', () => {
    expect(signature(obj({ a: { type: 'string' }, b: { type: 'integer' }, c: { type: 'boolean' }, d: { type: 'number' }, e: { type: 'string', maxLength: 9 } }, ['a', 'b']))).toBe('{a!,b!:int,c:bool,d:number,e}');
    expect(signature(obj({ list: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, nested: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }))).toBe('{list:(string|null)[],nested:string[][]}');
    expect(signature(obj({ v: {}, o: { type: 'object', additionalProperties: true } }))).toBe('{v:json,o:json-object}');
  });

  it('quotes a value or field name the notation could misread', () => {
    const s = obj({ v: { enum: ['plain', 'two words', 'string', 'json', '50% 20%', '1', 'Tone', 'kebab-case', 'dot.ted'] }, 'odd key': { type: 'string' }, n: { enum: [1, true] } });
    expect(signature(s)).toBe('{v:plain|"two words"|"string"|"json"|"50% 20%"|"1"|Tone|kebab-case|dot.ted,"odd key",n:1|true}');
    expectFaithful([s]);
  });

  it('names a repeated type once, after the fields it describes, but never a primitive', () => {
    const font = { enum: ['Inter', 'Lora', 'Georgia', 'system-ui'] };
    const { types, tools } = signatures([obj({ headingFont: font, bodyFont: font, a: { type: 'boolean' }, b: { type: 'boolean' }, c: { type: 'boolean' } }), obj({ titleFont: font })]);
    expect(types).toEqual(['Font=Inter|Lora|Georgia|system-ui']);
    expect(tools).toEqual(['{headingFont:Font,bodyFont:Font,a:bool,b:bool,c:bool}', '{titleFont:Font}']);
  });

  it('quotes a value spelled like a type name, so it is never read as the type', () => {
    const tone = { enum: ['default', 'muted', 'inverse'] };
    const s = obj({ tone, other: tone, pick: { enum: ['Tone', 'x'] } });
    const { types, tools } = signatures([s]);
    expect(types).toEqual(['Tone=default|muted|inverse']);
    expect(tools[0]).toBe('{tone:Tone,other:Tone,pick:"Tone"|x}');
    expectFaithful([s]);
  });

  it('starts an enum with the named enum it extends', () => {
    const tone = { enum: ['default', 'muted', 'inverse'] };
    const s = obj({ tone, textTone: tone, cardTone: tone, d: { enum: ['default', 'muted', 'inverse', 'brand'] }, e: { enum: ['muted', 'default', 'inverse', 'x'] } });
    expect(signatures([s]).tools[0]).toBe('{tone:Tone,textTone:Tone,cardTone:Tone,d:Tone|brand,e:muted|default|inverse|x}');
    expectFaithful([s]);
  });

  it('writes a union told apart by one field as a table, and shared runs of fields once', () => {
    const level = { enum: ['h1', 'h2', 'h3'] };
    const intro = { eyebrow: { type: 'string' }, heading: { type: 'string' }, level, lead: { type: 'string' } };
    const branch = (id: string, props: Record<string, JsonSchema>) => ({ type: 'object', properties: { componentId: { const: id }, index: { type: 'integer' }, props: { type: 'object', properties: props } }, required: ['componentId'] });
    const s = obj({ sections: { type: 'array', items: { anyOf: [branch('hero', { ...intro, image: { type: 'string' } }), branch('faq', { ...intro, items: { type: 'array', items: { type: 'string' } } }), branch('cta', { ...intro, button: { type: 'string' } }), branch('text', { body: { type: 'string' } })] } } }, []);
    const { types, tools } = signatures([s]);
    expect(tools[0]).toBe('{sections:Section[]}');
    expect(types.indexOf('EyebrowFields={eyebrow,heading,level:h1|h2|h3,lead}')).toBeLessThan(types.length - 1);
    expect(types.at(-1)).toBe('Section=one of these, by componentId!, each then with index:int:\nhero {props:{...EyebrowFields,image}}\nfaq {props:{...EyebrowFields,items:string[]}}\ncta {props:{...EyebrowFields,button}}\ntext {props:{body}}');
    expect(types).toContain('EyebrowFields={eyebrow,heading,level:h1|h2|h3,lead}');
    expectFaithful([s]);
  });

  it('defines each type before the first type that uses it', () => {
    for (const { label, tools } of constrainedToolSets()) {
      const { types } = signatures(tools.map((t) => toStrictSchema(t.parameters)));
      const names = types.map((t) => /^(\w+)=/.exec(t)![1]);
      types.forEach((t, i) => {
        const body = t.slice(names[i].length + 1).replace(/\.\.\.(?=\w)/g, ' ');
        for (const later of names.slice(i + 1)) expect(body, `${label}: ${names[i]} uses ${later}`).not.toMatch(new RegExp(`(?<![\\w.-])${later}(?![\\w-])`));
      });
    }
  });

  it('says exactly what every real tool takes, in every kind of constrained run', () => {
    for (const { label, tools } of constrainedToolSets()) expectFaithful(tools.map((t) => toStrictSchema(t.parameters)), label);
  });

  it('gives each tool its brief, or its description when it has none', () => {
    const text = envelopeInstructions([
      { name: 'a', description: 'Long A.', brief: 'Short A.', parameters: { type: 'object', properties: {} } },
      { name: 'b', description: 'Long B.', brief: '', parameters: { type: 'object', properties: {} } },
      { name: 'c', description: 'Long C.', parameters: { type: 'object', properties: { v: {} } } }
    ]);
    expect(text).toContain('- a {}\n  Short A.\n- b {}\n- c {v:json}\n  Long C.');
    expect(text).not.toContain('Long A.');
    expect(text).toContain('{"$json":"<its JSON text>"}');
    expect(envelopeInstructions([{ name: 'a', description: 'A.', parameters: { type: 'object', properties: { s: { type: 'string' } } } }])).not.toContain('$json');
  });
});
