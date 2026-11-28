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
