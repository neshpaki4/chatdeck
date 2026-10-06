const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// Рисуем иконку попиксельно: фиолетовый квадрат + белый баббл + точки
function makeIcon(size) {
  const S = size;
  const u = S / 32;
  const px = Buffer.alloc(S * S * 4);

  const inRR = (x, y, w, h, r, px_, py_) => {
    if (px_ < x - .5 || px_ > x + w - .5 || py_ < y - .5 || py_ > y + h - .5) return false;
    const cx = Math.max(x + r, Math.min(px_, x + w - r));
    const cy = Math.max(y + r, Math.min(py_, y + h - r));
    const dx = px_ - cx, dy = py_ - cy;
    return dx * dx + dy * dy <= r * r;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const tx = x / u, ty = y / u;
      let r = 0, g = 0, b = 0, a = 0;

      const inApp = inRR(1 * u, 1 * u, 30 * u, 30 * u, 8 * u, x, y);
      const inBubble = inRR(7 * u, 8 * u, 18 * u, 13 * u, 4 * u, x, y);
      const inTail = ty >= 20 && ty <= 26 && tx >= 11 && tx <= 16 - (ty - 21) * 0.9;
      const inDot = Math.hypot(tx - 12, ty - 14.5) <= 1.7 ||
                    Math.hypot(tx - 16, ty - 14.5) <= 1.7 ||
                    Math.hypot(tx - 20, ty - 14.5) <= 1.7;

      if (inApp) { r = 0x91; g = 0x47; b = 0xFF; a = 255; }
      if (inBubble || inTail) { r = 0xFF; g = 0xFF; b = 0xFF; a = 255; }
      if (inDot && inBubble) { r = 0x91; g = 0x47; b = 0xFF; a = 255; }

      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6;

  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// PNG внутрь ICO-контейнера (Windows, Vista+)
function pngToIco(pngBuf) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 0; header[7] = 0; // 0 = 256px
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngBuf.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, pngBuf]);
}

module.exports = { makeIcon, pngToIco };