const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

function sdSegment(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
    const dx = px - (ax + abx * t);
    const dy = py - (ay + aby * t);
    return Math.sqrt(dx * dx + dy * dy);
}

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
    const qx = Math.abs(px - cx) - (hw - r);
    const qy = Math.abs(py - cy) - (hh - r);
    const ox = qx > 0 ? qx : 0;
    const oy = qy > 0 ? qy : 0;
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

const G = {
    capTop: 0.30, capBot: 0.44, capR: 0.105,
    arcCX: 0.5, arcCY: 0.42, arcR: 0.185, arcT: 0.028,
    arcA0: 15 * Math.PI / 180, arcA1: 165 * Math.PI / 180,
    stemTop: 0.605, stemBot: 0.72, stemR: 0.028,
    baseL: 0.375, baseR: 0.625, baseY: 0.735, baseT: 0.028
};

function glyphDist(u, v) {
    let d = sdSegment(u, v, 0.5, G.capTop, 0.5, G.capBot) - G.capR;
    const dx = u - G.arcCX;
    const dy = v - G.arcCY;
    const len = Math.sqrt(dx * dx + dy * dy);
    const ang = Math.atan2(dy, dx);
    let angDist = 0;
    if (ang < G.arcA0) angDist = G.arcA0 - ang;
    else if (ang > G.arcA1) angDist = ang - G.arcA1;
    const dArc = Math.abs(len - G.arcR) - G.arcT + angDist * G.arcR;
    if (dArc < d) d = dArc;
    const dStem = sdSegment(u, v, 0.5, G.stemTop, 0.5, G.stemBot) - G.stemR;
    if (dStem < d) d = dStem;
    const dBase = sdSegment(u, v, G.baseL, G.baseY, G.baseR, G.baseY) - G.baseT;
    if (dBase < d) d = dBase;
    return d;
}

function sampleScene(u, v, px) {
    const bgD = sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.225);
    const bgA = clamp(0.5 - bgD / px, 0, 1);
    const tBg = clamp((v - 0.10) / 0.75, 0, 1);
    const bgR = lerp(36, 15, tBg);
    const bgG = lerp(43, 18, tBg);
    const bgB = lerp(64, 29, tBg);

    const gD = glyphDist(u, v);
    const gA = clamp(0.5 - gD / px, 0, 1);
    const tG = clamp((v - 0.18) / 0.58, 0, 1);
    const gR = lerp(125, 99, tG);
    const gG = lerp(211, 102, tG);
    const gB = lerp(252, 241, tG);

    return [
        lerp(bgR, gR, gA),
        lerp(bgG, gG, gA),
        lerp(bgB, gB, gA),
        bgA * 255
    ];
}

function render(size) {
    const ss = size <= 64 ? 4 : 2;
    const big = size * ss;
    const px = 1 / big;
    const acc = new Float64Array(size * size * 4);
    for (let by = 0; by < big; by++) {
        const v = (by + 0.5) / big;
        const ty = Math.floor(by / ss);
        for (let bx = 0; bx < big; bx++) {
            const u = (bx + 0.5) / big;
            const [r, g, b, a] = sampleScene(u, v, px);
            const ti = (ty * size + Math.floor(bx / ss)) * 4;
            acc[ti] += r * a;
            acc[ti + 1] += g * a;
            acc[ti + 2] += b * a;
            acc[ti + 3] += a;
        }
    }
    const out = Buffer.alloc(size * size * 4);
    const n = ss * ss;
    for (let i = 0; i < size * size; i++) {
        const a = acc[i * 4 + 3] / n;
        out[i * 4 + 3] = Math.round(a);
        if (a > 0) {
            out[i * 4] = Math.round(acc[i * 4] / acc[i * 4 + 3]);
            out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / acc[i * 4 + 3]);
            out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / acc[i * 4 + 3]);
        }
    }
    return out;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const stride = size * 4 + 1;
    const raw = Buffer.alloc(stride * size);
    for (let y = 0; y < size; y++) {
        raw[y * stride] = 0;
        rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
    }
    return Buffer.concat([
        sig,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function encodeBMP(size, rgba) {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    const xor = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        const src = (size - 1 - y) * size * 4;
        const dst = y * size * 4;
        for (let x = 0; x < size; x++) {
            xor[dst + x * 4] = rgba[src + x * 4 + 2];
            xor[dst + x * 4 + 1] = rgba[src + x * 4 + 1];
            xor[dst + x * 4 + 2] = rgba[src + x * 4];
            xor[dst + x * 4 + 3] = rgba[src + x * 4 + 3];
        }
    }
    const andRow = Math.ceil(Math.ceil(size / 8) / 4) * 4;
    const andMask = Buffer.alloc(andRow * size);
    return Buffer.concat([header, xor, andMask]);
}

function encodeICO(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = 6 + images.length * 16;
    const entries = [];
    for (const img of images) {
        const e = Buffer.alloc(16);
        e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
        e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
        e.writeUInt16LE(1, 4);
        e.writeUInt16LE(32, 6);
        e.writeUInt32LE(img.data.length, 8);
        e.writeUInt32LE(offset, 12);
        offset += img.data.length;
        entries.push(e);
    }
    return Buffer.concat([header, ...entries, ...images.map(i => i.data)]);
}

const SIZES = [16, 24, 32, 48, 64, 256];
const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

const renders = new Map();
for (const size of SIZES) renders.set(size, render(size));

const images = SIZES.map(size => ({
    size,
    data: size === 256 ? encodePNG(size, renders.get(size)) : encodeBMP(size, renders.get(size))
}));

fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeICO(images));
fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePNG(256, renders.get(256)));
console.log('Wrote build/icon.ico (%d sizes) and build/icon.png', SIZES.length);
