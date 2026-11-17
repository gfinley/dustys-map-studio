/**
 * Pure binary DPI metadata injectors for PNG (pHYs chunk) and JPEG (JFIF APP0).
 * Zero external dependencies.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected Uint8Array or ArrayBuffer.');
}

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function writeUint32BE(bytes, offset, value) {
  const v = value >>> 0;
  bytes[offset] = (v >>> 24) & 0xff;
  bytes[offset + 1] = (v >>> 16) & 0xff;
  bytes[offset + 2] = (v >>> 8) & 0xff;
  bytes[offset + 3] = v & 0xff;
}

function buildPhysChunk(dpi) {
  const ppm = Math.max(1, Math.round(dpi / 0.0254));
  const chunk = new Uint8Array(21);
  writeUint32BE(chunk, 0, 9);
  // "pHYs"
  chunk[4] = 0x70;
  chunk[5] = 0x48;
  chunk[6] = 0x59;
  chunk[7] = 0x73;
  writeUint32BE(chunk, 8, ppm);
  writeUint32BE(chunk, 12, ppm);
  chunk[16] = 1; // meter unit specifier
  const crc = crc32(chunk, 4, 17);
  writeUint32BE(chunk, 17, crc);
  return chunk;
}

export function injectPngDpi(pngBytes, dpi) {
  const bytes = toUint8Array(pngBytes);
  const targetDpi = Math.max(1, Math.round(Number(dpi) || 300));

  if (bytes.length < 33) {
    throw new Error('PNG data too short.');
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error('Invalid PNG signature.');
    }
  }

  const physChunk = buildPhysChunk(targetDpi);
  const chunks = [bytes.subarray(0, 8)];
  let pos = 8;
  let insertedPhys = false;

  while (pos + 12 <= bytes.length) {
    const length = readUint32BE(bytes, pos);
    const totalLen = 12 + length;
    if (pos + totalLen > bytes.length) {
      throw new Error('Truncated PNG chunk.');
    }

    const isIHDR =
      bytes[pos + 4] === 0x49 &&
      bytes[pos + 5] === 0x48 &&
      bytes[pos + 6] === 0x44 &&
      bytes[pos + 7] === 0x52;

    const isPHYs =
      bytes[pos + 4] === 0x70 &&
      bytes[pos + 5] === 0x48 &&
      bytes[pos + 6] === 0x59 &&
      bytes[pos + 7] === 0x73;

    const isIEND =
      bytes[pos + 4] === 0x49 &&
      bytes[pos + 5] === 0x45 &&
      bytes[pos + 6] === 0x4e &&
      bytes[pos + 7] === 0x44;

    if (!isPHYs) {
      chunks.push(bytes.subarray(pos, pos + totalLen));
      if (isIHDR && !insertedPhys) {
        chunks.push(physChunk);
        insertedPhys = true;
      }
    }

    pos += totalLen;
    if (isIEND) break;
  }

  if (pos < bytes.length) {
    chunks.push(bytes.subarray(pos));
  }

  let totalBytes = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    totalBytes += chunks[i].length;
  }

  const out = new Uint8Array(totalBytes);
  let writePos = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    out.set(chunks[i], writePos);
    writePos += chunks[i].length;
  }
  return out;
}

export function injectJpegDpi(jpegBytes, dpi) {
  const bytes = toUint8Array(jpegBytes);
  const targetDpi = Math.max(1, Math.min(65535, Math.round(Number(dpi) || 300)));

  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Invalid JPEG signature.');
  }

  const hi = (targetDpi >> 8) & 0xff;
  const lo = targetDpi & 0xff;

  let pos = 2;
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) break;
    while (pos + 1 < bytes.length && bytes[pos + 1] === 0xff) {
      pos += 1;
    }
    if (pos + 1 >= bytes.length) break;

    const marker = bytes[pos + 1];
    if (marker === 0xda || marker === 0xd9) {
      break;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2;
      continue;
    }

    if (pos + 3 >= bytes.length) break;
    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (segLen < 2 || pos + 2 + segLen > bytes.length) break;

    const isJfifApp0 =
      marker === 0xe0 &&
      segLen >= 16 &&
      bytes[pos + 4] === 0x4a &&
      bytes[pos + 5] === 0x46 &&
      bytes[pos + 6] === 0x49 &&
      bytes[pos + 7] === 0x46 &&
      bytes[pos + 8] === 0x00;

    if (isJfifApp0) {
      const out = new Uint8Array(bytes);
      out[pos + 11] = 1; // DPI units
      out[pos + 12] = hi;
      out[pos + 13] = lo;
      out[pos + 14] = hi;
      out[pos + 15] = lo;
      return out;
    }

    pos += 2 + segLen;
  }

  // Insert clean 18-byte JFIF APP0 right after SOI (FF D8)
  const app0 = new Uint8Array([
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x01,
    hi,
    lo,
    hi,
    lo,
    0x00,
    0x00,
  ]);

  const out = new Uint8Array(bytes.length + app0.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(bytes.subarray(2), 2 + app0.length);
  return out;
}
