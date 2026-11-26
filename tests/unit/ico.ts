/** Reads an ICO file's directory and the PNG images it holds. */
export function icoImages(ico: Buffer): Array<{ width: number; height: number; bitCount: number; png: Buffer }> {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('Not an ICO file.');
  let end = 6 + 16 * ico.readUInt16LE(4);
  const images = Array.from({ length: ico.readUInt16LE(4) }, (_, n) => {
    const at = 6 + 16 * n;
    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    // The images follow the directory one after another, with nothing between them.
    if (offset !== end) throw new Error('An image is not where the directory says.');
    end = offset + length;
    return { width: ico[at] || 256, height: ico[at + 1] || 256, bitCount: ico.readUInt16LE(at + 6), png: ico.subarray(offset, end) };
  });
  if (end !== ico.length) throw new Error('The file does not end with its last image.');
  return images;
}
