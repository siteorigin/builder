/** Model text read as written: paragraphs, lists, and a heading as a bold lead line. */
import { describe, expect, it } from 'vitest';
import { textBlocks } from '../../src/renderer/src/lib/model-text';

describe('model text', () => {
  it('keeps a plain reply as one paragraph, single line breaks and all', () => {
    expect(textBlocks('I left the button as it is.')).toEqual([{ kind: 'p', lines: ['I left the button as it is.'] }]);
    expect(textBlocks('First line\nsecond line')).toEqual([{ kind: 'p', lines: ['First line', 'second line'] }]);
  });

  it('splits paragraphs at blank lines and reads bulleted and numbered lists as lists', () => {
    const advice = 'It’s in good shape.\n\nTwo things I’d consider:\n\n- Add your **service area**.\n- Swap `team-2.jpg`.\n\n1. First\n2) Second\n\nThat’s all.';
    expect(textBlocks(advice)).toEqual([
      { kind: 'p', lines: ['It’s in good shape.'] },
      { kind: 'p', lines: ['Two things I’d consider:'] },
      { kind: 'ul', lines: ['Add your **service area**.', 'Swap `team-2.jpg`.'] },
      { kind: 'ol', lines: ['First', 'Second'] },
      { kind: 'p', lines: ['That’s all.'] }
    ]);
  });

  it('keeps a list whole across blank lines between items, and starts one right after a sentence', () => {
    expect(textBlocks('Consider:\n- One\n\n- Two\n• Three')).toEqual([
      { kind: 'p', lines: ['Consider:'] },
      { kind: 'ul', lines: ['One', 'Two', 'Three'] }
    ]);
  });

  it('turns a heading it should not have written into a lead line, and leaves nothing empty', () => {
    expect(textBlocks('## Summary\nAll done.\n\n\n')).toEqual([
      { kind: 'lead', lines: ['Summary'] },
      { kind: 'p', lines: ['All done.'] }
    ]);
    expect(textBlocks('   ')).toEqual([]);
  });
});
