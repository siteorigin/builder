import { describe, expect, it } from 'vitest';
import { SOURCE_KIND_LOCKED_HINT } from '../../src/renderer/src/lib/sources';

describe('source kind hint', () => {
  it('does not send the editor to detach as a way to connect another kind', () => {
    expect(SOURCE_KIND_LOCKED_HINT).not.toMatch(/Detach it to connect another/);
    expect(SOURCE_KIND_LOCKED_HINT).toMatch(/empty collection/);
    expect(SOURCE_KIND_LOCKED_HINT).toMatch(/keeps its entries/);
  });
});
