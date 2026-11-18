/** Pixel size of a PNG, JPEG or GIF from its header (null when the format is not recognised). */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: signature + IHDR (width, height as big-endian u32 at 16 and 20)
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: little-endian u16 at 6 and 8
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // JPEG: walk the segments up to a start-of-frame marker
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return null;
}
