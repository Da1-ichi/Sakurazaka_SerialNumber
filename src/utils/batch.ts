/**
 * 写真からのまとめ読み: 1 枚の写真に写った複数のシリアルの「行」を探す。
 *
 * 写真全体を OCR にかけると、細かい注意書きまで読んで遅く、取りこぼしも出る。
 * そこで先に画像処理だけで「同じ大きさの文字が 13 個前後、横一列に並んだ場所」
 * を探し、その行だけを元の解像度で切り出して、カメラ枠と同じ OCR にかける。
 *
 *   1. 縮小した写真を局所適応二値化し、黒い塊（連結成分）を拾う
 *   2. 文字らしい大きさ・形の塊だけを残す
 *   3. 高さがそろっていて横に近い塊をつないで「行」にする
 *   4. 行の長さ（幅÷文字の高さ）がシリアルらしいものを残す
 *   5. 写真の中で多数派の文字の大きさから外れる行を除く
 */
import { adaptiveBinarize, downscaleGray } from "./image";
import type { GrayImage } from "./image";

/** 見つけた行。座標は元の写真の画素 */
export type SerialLine = {
  /** 行の中心 */
  cx: number;
  cy: number;
  /** 行の傾き（ラジアン、右下がりが正） */
  angle: number;
  /** 行の長さ（文字の並び方向） */
  length: number;
  /** 文字の高さ */
  charHeight: number;
  /** つながった文字の数（目安） */
  charCount: number;
};

type Box = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 黒画素の数 */
  area: number;
};

const boxW = (b: Box) => b.x1 - b.x0 + 1;
const boxH = (b: Box) => b.y1 - b.y0 + 1;
const boxCy = (b: Box) => (b.y0 + b.y1) / 2;

/** 写真全体を縮小するときの長辺の画素数（文字探しはこの大きさで行う） */
export const DETECT_MAX_DIM = 2000;

/** 黒画素(0)の連結成分の外接矩形を求める（4 近傍、union-find） */
function connectedBoxes(bin: GrayImage): Box[] {
  const { width: w, height: h, data } = bin;
  const labels = new Int32Array(w * h);
  const parent: number[] = [0];
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (data[p] !== 0) continue;
      const left = x > 0 ? labels[p - 1] : 0;
      const up = y > 0 ? labels[p - w] : 0;
      if (!left && !up) {
        const id = parent.length;
        parent.push(id);
        labels[p] = id;
      } else if (left && up) {
        const a = find(left);
        const b = find(up);
        labels[p] = Math.min(a, b);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      } else {
        labels[p] = left || up;
      }
    }
  }

  const boxes = new Map<number, Box>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (!l) continue;
      const root = find(l);
      const b = boxes.get(root);
      if (b) {
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y;
        if (y > b.y1) b.y1 = y;
        b.area++;
      } else {
        boxes.set(root, { x0: x, y0: y, x1: x, y1: y, area: 1 });
      }
    }
  }
  return [...boxes.values()];
}

/** 中央値 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 縦に重なった塊（二値化で上下に割れた文字など）を 1 つにまとめる。
 * 横方向の重なりが小さい方の幅の 6 割以上で、縦の隙間が小さいものが対象。
 */
function mergeStacked(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => a.x0 - b.x0);
  const removed = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    if (removed.has(i)) continue;
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].x0 <= a.x1; j++) {
      if (removed.has(j)) continue;
      const b = sorted[j];
      // 幅が大きく違うもの（文字を囲む枠線など）はまとめない
      const wa = boxW(a);
      const wb = boxW(b);
      if (Math.max(wa, wb) > 2.5 * Math.min(wa, wb)) continue;
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
      if (overlap < 0.6 * Math.min(boxW(a), boxW(b))) continue;
      const gapY = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
      const maxH = Math.max(boxH(a), boxH(b));
      if (gapY > 0.25 * maxH) continue;
      // まとめた結果が縦長すぎる（別の行の文字同士）ならまとめない
      const merged: Box = {
        x0: Math.min(a.x0, b.x0),
        y0: Math.min(a.y0, b.y0),
        x1: Math.max(a.x1, b.x1),
        y1: Math.max(a.y1, b.y1),
        area: a.area + b.area,
      };
      if (boxH(merged) > 1.35 * maxH) continue;
      Object.assign(a, merged);
      removed.add(j);
    }
  }
  return sorted.filter((_, i) => !removed.has(i));
}

/** 塊の並び（左から右）を、高さ・位置のそろった「鎖」にする */
function chainBoxes(boxes: Box[]): Box[][] {
  const sorted = [...boxes].sort((a, b) => a.x0 - b.x0);
  const next = new Int32Array(sorted.length).fill(-1);
  const prevGap = new Float64Array(sorted.length).fill(Infinity);
  const prev = new Int32Array(sorted.length).fill(-1);

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const ha = boxH(a);
    let best = -1;
    let bestGap = Infinity;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const gap = b.x0 - a.x1;
      if (gap > 1.0 * ha) break; // x0 順なので、これ以降はもっと遠い
      if (gap < -0.15 * ha) continue;
      const hb = boxH(b);
      const ratio = hb / ha;
      if (ratio < 0.75 || ratio > 1.33) continue;
      if (Math.abs(boxCy(b) - boxCy(a)) > 0.3 * Math.max(ha, hb)) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = j;
      }
    }
    if (best < 0) continue;
    // 受け側にすでにもっと近い前の塊があれば、そちらを優先
    if (bestGap < prevGap[best]) {
      if (prev[best] >= 0) next[prev[best]] = -1;
      prev[best] = i;
      prevGap[best] = bestGap;
      next[i] = best;
    }
  }

  const chains: Box[][] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (prev[i] >= 0) continue;
    const chain: Box[] = [];
    for (let k = i; k >= 0; k = next[k]) chain.push(sorted[k]);
    chains.push(chain);
  }
  return chains;
}

/** 鎖の中心線（最小二乗の直線）と、文字の高さなどをまとめる */
function describeChain(chain: Box[], scaleBack: number): SerialLine {
  const xs = chain.map((b) => (b.x0 + b.x1) / 2);
  const ys = chain.map(boxCy);
  const n = chain.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const angle = Math.atan(slope);
  const x0 = Math.min(...chain.map((b) => b.x0));
  const x1 = Math.max(...chain.map((b) => b.x1));
  const length = (x1 - x0 + 1) / Math.cos(angle);
  const cxLocal = (x0 + x1) / 2;
  const cyLocal = my + slope * (cxLocal - mx);
  return {
    cx: cxLocal * scaleBack,
    cy: cyLocal * scaleBack,
    angle,
    length: length * scaleBack,
    charHeight: median(chain.map(boxH)) * scaleBack,
    charCount: n,
  };
}

/** ほぼ一直線上で近い 2 本の行を 1 本につなぐ（途中の文字を取りこぼした場合） */
function joinChains(chains: Box[][]): Box[][] {
  const list = chains
    .filter((c) => c.length >= 2)
    .map((c) => ({ boxes: c, h: median(c.map(boxH)) }))
    .sort((a, b) => a.boxes[0].x0 - b.boxes[0].x0);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const a = list[i];
        const b = list[j];
        const lastA = a.boxes[a.boxes.length - 1];
        const firstB = b.boxes[0];
        const gap = firstB.x0 - lastA.x1;
        const h = Math.max(a.h, b.h);
        if (gap < 0 || gap > 2.2 * h) continue;
        const ratio = b.h / a.h;
        if (ratio < 0.8 || ratio > 1.25) continue;
        if (Math.abs(boxCy(firstB) - boxCy(lastA)) > 0.35 * h) continue;
        a.boxes = [...a.boxes, ...b.boxes];
        a.h = median(a.boxes.map(boxH));
        list.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return list.map((c) => c.boxes);
}

/**
 * 写真（グレースケール、元の解像度）から、シリアルらしい行を探す。
 * 戻り値は上から下、左から右の順。
 */
export function detectSerialLines(photo: GrayImage): SerialLine[] {
  const scale = Math.min(1, DETECT_MAX_DIM / Math.max(photo.width, photo.height));
  const small = downscaleGray(photo, scale);
  const maxDim = Math.max(small.width, small.height);

  // 1. 二値化。窓は写真の大きさに比例させる（文字の高さの 1〜3 倍程度を想定）
  const win = Math.max(15, Math.round(maxDim / 40) | 1);
  const bin = adaptiveBinarize(small, win, 15);

  // 2. 文字らしい塊だけを残す
  const minH = Math.max(8, maxDim * 0.006);
  const maxH = maxDim * 0.1;
  const boxes = mergeStacked(connectedBoxes(bin)).filter((b) => {
    const w = boxW(b);
    const h = boxH(b);
    if (h < minH || h > maxH) return false;
    if (w < 0.12 * h || w > 1.4 * h) return false;
    const fill = b.area / (w * h);
    return fill > 0.08 && fill < 0.9;
  });

  // 3. 鎖にして、途切れた鎖をつなぐ
  const chains = joinChains(chainBoxes(boxes));

  // 4. シリアルらしい長さの行だけを残す（13 文字 × 文字送り ≒ 高さの 10 倍前後）
  const scaleBack = 1 / scale;
  let lines = chains
    .filter((c) => c.length >= 7 && c.length <= 18)
    .map((c) => describeChain(c, scaleBack))
    .filter((l) => {
      const ratio = l.length / l.charHeight;
      return ratio >= 6.5 && ratio <= 14.5 && Math.abs(l.angle) < 0.35;
    });

  // 5. 多数派の文字の大きさから大きく外れる行を除く
  //   （注意書き・URL など、別の大きさの文字の並びを落とすため）
  const typical = median(
    lines.filter((l) => l.charCount >= 11 && l.charCount <= 15).map((l) => l.charHeight)
  );
  if (typical > 0) {
    lines = lines.filter(
      (l) => l.charHeight >= typical * 0.65 && l.charHeight <= typical * 1.5
    );
  }

  // 上から下、ほぼ同じ高さなら左から右
  const rowTol = typical || 20;
  return lines.sort((a, b) =>
    Math.abs(a.cy - b.cy) > rowTol ? a.cy - b.cy : a.cx - b.cx
  );
}

/**
 * 行を OCR 用に切り出すときの範囲（元の写真の座標）。
 * 左右は文字の高さ 0.8 個ぶん、上下は行の中心から文字の高さ 1.1 個ぶん。
 * 上下を広げすぎると、枠線や「シリアルナンバー」の小さな文字が入る。
 */
export function lineCropRect(line: SerialLine) {
  return {
    cx: line.cx,
    cy: line.cy,
    angle: line.angle,
    width: line.length + line.charHeight * 1.6,
    height: line.charHeight * 2.2,
  };
}

// ─── 1 文字ずつの切り分けと、字形の特徴 ─────────────────────────

/** 字形を比べるときの大きさ（横×縦の画素） */
export const GLYPH_W = 20;
export const GLYPH_H = 28;

/** 切り出した行画像の中の 1 文字の範囲 */
export type CharBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * 二値化した行画像から、文字の外接矩形を左から順に取り出す。
 * charHeight は行画像での文字の高さの目安。
 * 行の上下中央付近にあって、文字の高さに近い塊だけを使う。
 */
export function segmentCharacters(bin: GrayImage, charHeight: number): CharBox[] {
  const midY = bin.height / 2;
  const boxes = mergeStacked(connectedBoxes(bin)).filter((b) => {
    const h = boxH(b);
    const w = boxW(b);
    if (h < 0.7 * charHeight || h > 1.35 * charHeight) return false;
    if (w < 0.12 * h || w > 1.2 * h) return false;
    return Math.abs(boxCy(b) - midY) < 0.4 * charHeight;
  });
  return boxes
    .sort((a, b) => a.x0 - b.x0)
    .map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
}

/**
 * 1 文字ぶんの字形を、決まった大きさの数値列にする（平均 0・大きさ 1 に正規化）。
 * 等幅フォントなので、横は文字の中心から文字送りぶん（高さ×0.85）の枠を取り、
 * 細い字（J など）を横に引き伸ばさないようにする。縦は行の文字の上端〜下端。
 */
export function glyphVector(
  gray: GrayImage,
  box: CharBox,
  top: number,
  bottom: number
): Float32Array {
  const h = bottom - top + 1;
  const cellW = h * 0.85;
  const cx = (box.x0 + box.x1 + 1) / 2;
  const left = cx - cellW / 2;
  const v = new Float32Array(GLYPH_W * GLYPH_H);
  const { width: W, height: H, data } = gray;
  for (let gy = 0; gy < GLYPH_H; gy++) {
    const sy0 = top + (gy * h) / GLYPH_H;
    const sy1 = top + ((gy + 1) * h) / GLYPH_H;
    for (let gx = 0; gx < GLYPH_W; gx++) {
      const sx0 = left + (gx * cellW) / GLYPH_W;
      const sx1 = left + ((gx + 1) * cellW) / GLYPH_W;
      // 面積平均（範囲外は白）
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) {
        for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
          sum += x < 0 || y < 0 || x >= W || y >= H ? 255 : data[y * W + x];
          n++;
        }
      }
      // 黒いほど大きい値にする
      v[gy * GLYPH_W + gx] = 255 - sum / Math.max(1, n);
    }
  }
  let mean = 0;
  for (const x of v) mean += x;
  mean /= v.length;
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] -= mean;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}
