// Tabela de cores AutoCAD Color Index (ACI) 1–255.
// Gerada algoritmicamente: os índices 10–249 seguem um padrão de matiz/saturação/brilho.

const BASE = [
  null,
  [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255],
  [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192],
];

const GRAYS = {
  250: [51, 51, 51], 251: [80, 80, 80], 252: [105, 105, 105],
  253: [130, 130, 130], 254: [190, 190, 190], 255: [255, 255, 255],
};

const LEVELS = [255, 204, 153, 127, 76];

function hsv(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round(r + m), Math.round(g + m), Math.round(b + m)];
}

const cache = new Map();

export function aciToRgb(i) {
  i = Math.abs(i | 0);
  if (i >= 1 && i <= 9) return BASE[i];
  if (i >= 250 && i <= 255) return GRAYS[i];
  if (i >= 10 && i <= 249) {
    const hue = (Math.floor(i / 10) - 1) * 15;
    const sub = i % 10;
    return hsv(hue, sub & 1 ? 0.5 : 1, LEVELS[sub >> 1]);
  }
  return [255, 255, 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export function aciToHex(i) {
  let hex = cache.get(i);
  if (!hex) {
    hex = rgbToHex(aciToRgb(i));
    cache.set(i, hex);
  }
  return hex;
}

export function intToHex(rgb) {
  return '#' + ((rgb & 0xffffff) | (1 << 24)).toString(16).slice(1);
}
