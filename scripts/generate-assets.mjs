#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'characters');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const smin = (a, b, k) => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
};
const len3 = (x, y, z) => Math.hypot(x, y, z);
const norm3 = (x, y, z) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const reflect3 = (i, n) => {
  const d = 2 * dot3(i, n);
  return [i[0] - d * n[0], i[1] - d * n[1], i[2] - d * n[2]];
};

function rotX(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}
function rotY(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}
function rotZ(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

function sdRoundBox(p, b, r) {
  const qx = Math.abs(p[0]) - b[0];
  const qy = Math.abs(p[1]) - b[1];
  const qz = Math.abs(p[2]) - b[2];
  return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

function sdTorus(p, t0, t1) {
  const qx = Math.hypot(p[0], p[2]) - t0;
  return Math.hypot(qx, p[1]) - t1;
}

function sdOctahedron(p, s) {
  return (Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]) - s) * 0.57735027;
}

function sdPillowStar(p, nPoints, baseR, ampR, thick) {
  const r2 = Math.sqrt(p[0] * p[0] + p[1] * p[1] + 0.025);
  const a = Math.atan2(p[1], p[0]) - (nPoints === 5 ? Math.PI / 2 : 0);
  const w = clamp((r2 - 0.14) / 0.35, 0, 1);
  const starR = baseR + ampR * w * Math.cos(nPoints * a);
  const d2d = (r2 - starR) * 0.68;
  const dome = thick * Math.max(0.14, 1 - Math.pow(r2 / (baseR + ampR + 0.16), 1.65));
  const dz = Math.abs(p[2]) - dome;
  return (len3(Math.max(d2d, 0), Math.max(dz, 0), 0) + Math.min(Math.max(d2d, dz), 0) - 0.11) * 0.72;
}

function sampleStudioEnv(r, iridescent = 0) {
  const y = clamp(r[1] * 0.5 + 0.5, 0, 1);
  let er = mix(0.08, 0.95, Math.pow(y, 1.8));
  let eg = mix(0.10, 0.97, Math.pow(y, 1.7));
  let eb = mix(0.16, 1.05, Math.pow(y, 1.5));

  const w1 = Math.max(0, dot3(r, norm3(-0.52, 0.68, 0.52)));
  const soft1 = Math.pow(w1, 9) * 2.8;
  const w2 = Math.max(0, dot3(r, norm3(0.76, 0.25, 0.58)));
  const soft2 = Math.pow(w2, 16) * 1.4;

  if (iridescent > 0) {
    const phase = Math.atan2(r[1], r[0]) * 2.0 + r[2] * 3.2;
    const ir = 0.52 + 0.46 * Math.cos(phase + 0.0);
    const ig = 0.56 + 0.42 * Math.cos(phase + 2.1);
    const ib = 0.62 + 0.38 * Math.cos(phase + 4.2);
    er = mix(er, ir * 1.25, iridescent);
    eg = mix(eg, ig * 1.25, iridescent);
    eb = mix(eb, ib * 1.35, iridescent);
  }

  return [er + soft1 + soft2 * 0.9, eg + soft1 + soft2 * 0.95, eb + soft1 + soft2 * 1.1];
}

const CHARACTERS = [
  {
    name: 'mascot',
    sdf(p0) {
      const p = rotZ(rotY(rotX(p0, -0.12), 0.16), -0.10);
      return sdPillowStar(p, 4, 0.58, 0.28, 0.34);
    },
    mat(p, n) {
      const nxy = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
      return {
        albedo: [0.66 + 0.28 * n[0] + 0.10 * n[1], 0.76 + 0.20 * n[1] - 0.10 * n[0], 0.96 - 0.08 * nxy],
        rough: 0.10,
        metal: 0.56,
        irid: 0.65,
        sss: [0.45, 0.6, 0.95],
      };
    },
  },
  {
    name: 'mochi',
    sdf(p0) {
      const p = rotZ(rotY(p0, -0.14), 0.04);
      const widen = 1 + 0.13 * clamp(-p[1], -1, 1);
      const main = len3(p[0] / widen, p[1] * 1.08 + 0.06, p[2] / widen) - 0.74;
      const earL = len3(p[0] + 0.33, p[1] - 0.60, p[2] * 1.1) - 0.21;
      const earR = len3(p[0] - 0.33, p[1] - 0.60, p[2] * 1.1) - 0.21;
      return smin(main, Math.min(earL, earR), 0.22);
    },
    mat(p) {
      const g = clamp(p[1] * 0.6 + 0.5, 0, 1);
      return { albedo: [mix(0.86, 0.98, g), mix(0.14, 0.32, g), mix(0.12, 0.22, g)], rough: 0.12, metal: 0.02, irid: 0, sss: [0.95, 0.22, 0.08] };
    },
  },
  {
    name: 'voxel',
    sdf(p0) {
      const p = rotX(rotY(rotZ(p0, -0.08), -0.36), 0.22);
      return sdRoundBox(p, [0.50, 0.50, 0.50], 0.18);
    },
    mat(p, n) {
      const up = clamp(n[1] * 0.5 + 0.5, 0, 1);
      return { albedo: [mix(0.22, 0.62, up), mix(0.72, 0.94, up), mix(0.14, 0.26, up)], rough: 0.13, metal: 0.03, irid: 0, sss: [0.42, 0.92, 0.15] };
    },
  },
  {
    name: 'sprout',
    sdf(p0) {
      const p = rotZ(rotY(p0, 0.14), -0.04);
      const taper = 1 - 0.18 * clamp(p[1], -0.8, 0.8);
      const body = len3(p[0] / taper, p[1] + 0.14, p[2] / taper) * 0.85 - 0.58;
      const leafL = len3((p[0] + 0.24) * 1.1, (p[1] - 0.64) * 1.6, p[2] * 1.8) * 0.56 - 0.16;
      const leafR = len3((p[0] - 0.24) * 1.1, (p[1] - 0.64) * 1.6, p[2] * 1.8) * 0.56 - 0.16;
      return smin(body, Math.min(leafL, leafR), 0.14);
    },
    mat(p) {
      const top = clamp((p[1] + 0.3) * 0.9, 0, 1);
      return { albedo: [mix(0.16, 0.38, top), mix(0.70, 0.92, top), mix(0.32, 0.22, top)], rough: 0.14, metal: 0.02, irid: 0, sss: [0.25, 0.95, 0.35] };
    },
  },
  {
    name: 'cloudy',
    sdf(p0) {
      const p = rotX(rotY(p0, -0.12), 0.08);
      const c0 = len3(p[0], p[1] + 0.06, p[2] * 1.15) * 0.86 - 0.52;
      const c1 = len3(p[0] + 0.44, p[1] + 0.14, p[2] * 1.2) * 0.84 - 0.38;
      const c2 = len3(p[0] - 0.44, p[1] + 0.14, p[2] * 1.2) * 0.84 - 0.38;
      const c3 = len3(p[0] - 0.14, p[1] - 0.28, p[2] * 1.2) * 0.84 - 0.36;
      return smin(smin(c0, c1, 0.24), smin(c2, c3, 0.24), 0.24);
    },
    mat(p, n) {
      const up = clamp(n[1] * 0.5 + 0.5, 0, 1);
      return { albedo: [mix(0.72, 0.99, up), mix(0.84, 0.99, up), mix(0.98, 1.0, up)], rough: 0.18, metal: 0.02, irid: 0.06, sss: [0.65, 0.85, 1.0] };
    },
  },
  {
    name: 'blaze',
    sdf(p0) {
      const p = rotZ(rotY(p0, 0.18), 0.06);
      const y = p[1] + 0.08;
      const pinch = clamp(1 - (y + 0.5) * 0.52, 0.22, 1.25);
      const wave = Math.sin(y * 3.5) * 0.07 * clamp(y + 0.3, 0, 1.4);
      const flame = len3((p[0] - wave) / pinch, y * 0.88, p[2] / pinch) * 0.62 - 0.48;
      return flame;
    },
    mat(p) {
      const h = clamp((p[1] + 0.65) * 0.75, 0, 1);
      return { albedo: [1.0, mix(0.18, 0.78, h), mix(0.05, 0.16, h)], rough: 0.11, metal: 0.08, irid: 0.05, sss: [1.0, 0.45, 0.05] };
    },
  },
  {
    name: 'ripple',
    sdf(p0) {
      const p = rotX(rotY(p0, -0.22), 0.24);
      const core = len3(p[0], p[1] * 0.96, p[2]) - 0.55;
      const halo = sdTorus(rotZ(p, 0.42), 0.82, 0.11) * 0.75;
      return smin(core, halo, 0.16);
    },
    mat(p, n) {
      const up = clamp(n[1] * 0.5 + 0.5, 0, 1);
      return { albedo: [mix(0.05, 0.26, up), mix(0.68, 0.94, up), mix(0.86, 0.99, up)], rough: 0.08, metal: 0.18, irid: 0.22, sss: [0.08, 0.88, 1.0] };
    },
  },
  {
    name: 'amethyst',
    sdf(p0) {
      const p = rotY(rotX(p0, 0.16), 0.30);
      const d1 = sdOctahedron([p[0] * 0.94, p[1] * 0.88, p[2] * 0.94], 1.02) - 0.06;
      const pr = rotY(rotZ(p, 0.54), 0.76);
      const d2 = sdOctahedron(pr, 1.00) - 0.06;
      const h = clamp(0.5 - (0.5 * (d2 - d1)) / 0.08, 0, 1);
      return mix(d2, d1, h) + 0.08 * h * (1 - h);
    },
    mat(p, n) {
      const f = clamp(n[0] * 0.5 + n[1] * 0.35 + 0.5, 0, 1);
      return { albedo: [mix(0.24, 0.58, f), mix(0.08, 0.22, f), mix(0.78, 0.98, f)], rough: 0.07, metal: 0.36, irid: 0.32, sss: [0.55, 0.12, 0.95] };
    },
  },
  {
    name: 'saturn',
    sdf(p0) {
      const p = rotZ(rotX(p0, 0.35), -0.24);
      const planet = len3(p0[0], p0[1] * 1.02, p0[2]) - 0.58;
      const ring = sdTorus([p[0], p[1] * 2.1, p[2]], 0.88, 0.085) * 0.65;
      return Math.min(planet, ring);
    },
    mat(p0) {
      const p = rotZ(rotX(p0, 0.35), -0.24);
      const dPlanet = len3(p0[0], p0[1] * 1.02, p0[2]) - 0.58;
      const dRing = sdTorus([p[0], p[1] * 2.1, p[2]], 0.88, 0.085) * 0.65;
      if (dRing < dPlanet + 0.01) {
        const band = 0.5 + 0.5 * Math.sin(Math.hypot(p[0], p[2]) * 42);
        return { albedo: [mix(0.88, 0.99, band), mix(0.72, 0.90, band), mix(0.32, 0.58, band)], rough: 0.14, metal: 0.42, irid: 0.15, sss: [0.9, 0.7, 0.3] };
      }
      const lat = 0.5 + 0.5 * Math.sin(p0[1] * 7 + p0[0] * 2);
      return { albedo: [mix(0.10, 0.24, lat), mix(0.24, 0.52, lat), mix(0.85, 0.99, lat)], rough: 0.12, metal: 0.15, irid: 0.1, sss: [0.12, 0.45, 0.98] };
    },
  },
  {
    name: 'nebula',
    sdf(p0) {
      const p = rotX(rotY(p0, 0.28), 1.18);
      const donut = sdTorus(p, 0.52, 0.29);
      const pearl = len3(p0[0], p0[1], p0[2] - 0.06) - 0.34;
      return Math.min(donut, pearl);
    },
    mat(p0, n) {
      const dCore = len3(p0[0], p0[1], p0[2] - 0.06) - 0.34;
      if (dCore < 0.01) {
        return { albedo: [0.98, 0.86, 0.99], rough: 0.10, metal: 0.25, irid: 0.45, sss: [0.9, 0.5, 1.0] };
      }
      const sw = 0.5 + 0.5 * Math.sin(Math.atan2(p0[1], p0[0]) * 3 + n[2] * 2);
      return { albedo: [mix(0.88, 0.42, sw), mix(0.14, 0.18, sw), mix(0.68, 0.96, sw)], rough: 0.09, metal: 0.35, irid: 0.42, sss: [0.95, 0.15, 0.75] };
    },
  },
  {
    name: 'helios',
    sdf(p0) {
      const p = rotY(rotX(rotZ(p0, 0.05), -0.10), -0.16);
      return sdPillowStar(p, 5, 0.58, 0.23, 0.35);
    },
    mat(p, n) {
      const up = clamp(n[1] * 0.5 + 0.5, 0, 1);
      return { albedo: [1.0, mix(0.66, 0.85, up), mix(0.08, 0.22, up)], rough: 0.11, metal: 0.48, irid: 0.06, sss: [1.0, 0.62, 0.08] };
    },
  },
  {
    name: 'astral',
    sdf(p0) {
      // Secret Prismatic Relic: levitating obsidian-opal core inside intersecting celestial rings
      const p = rotY(rotX(p0, 0.28), -0.26);
      const core = sdOctahedron([p[0], p[1] * 0.88, p[2]], 0.68) - 0.09;
      const r1 = sdTorus(rotZ(rotX(p, 0.72), 0.45), 0.82, 0.075);
      const r2 = sdTorus(rotZ(rotX(p, -0.68), -0.52), 0.82, 0.075);
      return Math.min(core, Math.min(r1, r2));
    },
    mat(p0, n) {
      const p = rotY(rotX(p0, 0.28), -0.26);
      const dCore = sdOctahedron([p[0], p[1] * 0.88, p[2]], 0.68) - 0.09;
      if (dCore < 0.015) {
        return {
          albedo: [0.16 + 0.22 * Math.abs(n[0]), 0.18 + 0.22 * Math.abs(n[1]), 0.28 + 0.25 * Math.abs(n[2])],
          rough: 0.06,
          metal: 0.88,
          irid: 0.92,
          sss: [0.4, 0.2, 0.9],
        };
      }
      return {
        albedo: [0.96, 0.84, 0.55],
        rough: 0.08,
        metal: 0.78,
        irid: 0.55,
        sss: [1.0, 0.75, 0.3],
      };
    },
  },
];

function calcNormal(sdf, p) {
  const e = 0.0014;
  const dx = sdf([p[0] + e, p[1], p[2]]) - sdf([p[0] - e, p[1], p[2]]);
  const dy = sdf([p[0], p[1] + e, p[2]]) - sdf([p[0], p[1] - e, p[2]]);
  const dz = sdf([p[0], p[1], p[2] + e]) - sdf([p[0], p[1], p[2] - e]);
  return norm3(dx, dy, dz);
}

const KEY_LIGHT = norm3(-0.52, 0.68, 0.74);
const FILL_LIGHT = norm3(0.72, -0.28, 0.55);
const RIM_LIGHT = norm3(0.12, 0.85, -0.62);

function renderCharacter(def, size = 360) {
  const buf = Buffer.alloc(size * size * 4);
  const samples = [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;

      for (const [ox, oy] of samples) {
        const u = ((px + 0.5 + ox) / size) * 2 - 1;
        const vCoord = 1 - ((py + 0.5 + oy) / size) * 2;
        const scale = 1.15;
        const ro = [u * scale * 0.12, vCoord * scale * 0.12, 3.2];
        const rd = norm3(u * scale * 0.34, vCoord * scale * 0.34, -1.0);

        let t = 1.6;
        let hit = false;
        for (let step = 0; step < 60; step++) {
          const pos = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
          const d = def.sdf(pos);
          if (d < 0.0011) { hit = true; break; }
          t += d;
          if (t > 4.6) break;
        }

        if (hit) {
          const pos = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
          const n = calcNormal(def.sdf, pos);
          const view = [-rd[0], -rd[1], -rd[2]];
          const m = def.mat(pos, n, view);

          const base = m.albedo.map((c) => Math.pow(clamp(c, 0, 1), 2.2));
          const sss = m.sss.map((c) => Math.pow(clamp(c, 0, 1), 2.2));

          const ndv = clamp(dot3(n, view), 0, 1);
          const fresnel = Math.pow(1 - ndv, 4.0);
          const f0 = m.metal;

          const diffKey = Math.max(0, dot3(n, KEY_LIGHT));
          const wrapKey = clamp((dot3(n, KEY_LIGHT) + 0.38) / 1.38, 0, 1);
          const diffFill = Math.max(0, dot3(n, FILL_LIGHT));
          const rim = Math.pow(1 - ndv, 2.5) * (0.35 + 0.65 * Math.max(0, dot3(n, RIM_LIGHT)));

          const aoPos = [pos[0] + n[0] * 0.13, pos[1] + n[1] * 0.13, pos[2] + n[2] * 0.13];
          const ao = clamp(0.55 + 0.45 * (def.sdf(aoPos) / 0.13), 0.45, 1.0);

          const reflDir = reflect3(rd, n);
          const env = sampleStudioEnv(reflDir, m.irid);

          const hKey = norm3(KEY_LIGHT[0] + view[0], KEY_LIGHT[1] + view[1], KEY_LIGHT[2] + view[2]);
          const shininess = mix(140, 22, m.rough);
          const spec = Math.pow(Math.max(0, dot3(n, hKey)), shininess) * 1.35;

          const kd = (1 - f0) * (1 - fresnel * 0.65);
          const diffuseLight = 0.22 * ao + wrapKey * 0.92 + diffFill * 0.22;

          let cr = kd * (base[0] * diffuseLight + sss[0] * (1 - diffKey) * 0.14);
          let cg = kd * (base[1] * diffuseLight + sss[1] * (1 - diffKey) * 0.14);
          let cb = kd * (base[2] * diffuseLight + sss[2] * (1 - diffKey) * 0.14);

          const specTintR = mix(0.06 + fresnel * 0.75, base[0] * 0.85 + 0.25, f0);
          const specTintG = mix(0.06 + fresnel * 0.75, base[1] * 0.85 + 0.25, f0);
          const specTintB = mix(0.06 + fresnel * 0.75, base[2] * 0.85 + 0.25, f0);

          cr += env[0] * specTintR + spec * mix(1, base[0] + 0.3, f0 * 0.6) + rim * 0.22;
          cg += env[1] * specTintG + spec * mix(1, base[1] + 0.3, f0 * 0.6) + rim * 0.24;
          cb += env[2] * specTintB + spec * mix(1, base[2] + 0.3, f0 * 0.6) + rim * 0.30;

          const aces = (x) => {
            const v = Math.max(0, x);
            const mapped = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
            return Math.pow(clamp(mapped, 0, 1), 1 / 2.2);
          };

          rAcc += aces(cr);
          gAcc += aces(cg);
          bAcc += aces(cb);
          aAcc += 1;
        }
      }

      if (aAcc > 0) {
        const idx = (py * size + px) * 4;
        buf[idx] = Math.round((rAcc / aAcc) * 255);
        buf[idx + 1] = Math.round((gAcc / aAcc) * 255);
        buf[idx + 2] = Math.round((bAcc / aAcc) * 255);
        buf[idx + 3] = Math.round((aAcc / samples.length) * 255);
      }
    }
  }

  const outPath = path.join(OUT_DIR, `${def.name}.png`);
  fs.writeFileSync(outPath, encodePNG(size, size, buf));
  console.log(`Generated ${outPath}`);
}

for (const ch of CHARACTERS) {
  renderCharacter(ch, 360);
}
