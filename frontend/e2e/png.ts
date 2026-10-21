import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A small, valid RGB PNG: a gradient with a random first row, so every call is a file the API
 * hasn't seen (it refuses a document already bound to another listing). It passes the upload
 * checks: magic bytes, CRCs, nothing after IEND, and too little random data to hold a ZIP or
 * PDF signature by chance.
 */
export function uniquePng(size = 48): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: RGB
  const rows = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    rows[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const at = row + 1 + x * 3;
      rows[at] = (x * 255) / size;
      rows[at + 1] = (y * 255) / size;
      rows[at + 2] = 128;
    }
  }
  randomBytes(16).copy(rows, 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
