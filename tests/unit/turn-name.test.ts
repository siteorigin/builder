import { describe, expect, it } from 'vitest';
import { turnName } from '../../src/agent/turn-name';

describe('turnName', () => {
  it('drops link targets and emphasis', () => {
    expect(turnName('I added [Where to Buy](/where-to-buy/) to the main menu. More text.', 'x')).toBe('I added Where to Buy to the main menu.');
    expect(turnName('I added **The Heat Check** to the homepage.', 'x')).toBe('I added The Heat Check to the homepage.');
    expect(turnName('Used `code` and _italic_ here.', 'x')).toBe('Used code and italic here.');
  });
  it('cuts at a word boundary', () => {
    const name = turnName('I updated the [Subscription page](/subscription/) with Spark at R249/month, Slow shipping and many more things besides', 'x');
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith('…')).toBe(true);
    expect(name).not.toMatch(/\bSl…$/);
  });
  it('falls back to the request', () => {
    expect(turnName('', 'Make it **bold**')).toBe('Make it bold');
  });
});

describe('turnName edge cases', () => {
  it('keeps code and URLs as written', () => {
    expect(turnName('Renamed `__init__` and a * b * c.', 'x')).toBe('Renamed __init__ and a * b * c.');
    expect(turnName('See https://example.com/_docs_/ now.', 'x')).toBe('See https://example.com/_docs_/ now.');
    expect(turnName('Linked <https://example.com> here.', 'x')).toBe('Linked https://example.com here.');
  });
  it('does not end the sentence inside a link text', () => {
    expect(turnName('I linked [Acme Inc.](/acme) in the footer. More text.', 'x')).toBe('I linked Acme Inc. in the footer.');
    expect(turnName('I set it to “Ready!” The CTA now says Go.', 'x')).toBe('I set it to “Ready!”');
  });
  it('handles targets with parentheses', () => {
    expect(turnName('See [FAQ](https://example.com/FAQ_(shop)) today.', 'x')).toBe('See FAQ today.');
  });
  it('cuts a long word and never leaves a name empty', () => {
    expect(turnName(`I updated the hero and its ${'x'.repeat(90)}.`, 'y')).toBe('I updated the hero and its…');
    expect(turnName('```\ncode\n```', 'Add a hero')).toBe('Add a hero');
    expect(turnName('', '')).toBe('Changes');
  });
});
