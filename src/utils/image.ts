/**
 * 画像処理の共通部品（canvas に依存しない、グレースケール配列の処理）。
 * カメラ枠の読み取りと、写真からのまとめ読みの両方で使う。
 */

/** 1 画素 1 バイトのグレースケール画像 */
export type GrayImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

/** RGBA の画素列をグレースケールにする */
export function rgbaToGray(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): GrayImage {
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; p < data.length; i += 4, p++) {
    data[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return { width, height, data };
}

/** グレースケールを RGBA の画素列（canvas の ImageData 用）に戻す */
export function grayToRgba(img: GrayImage, out?: Uint8ClampedArray) {
  const rgba = out ?? new Uint8ClampedArray(img.width * img.height * 4);
  for (let p = 0, i = 0; p < img.data.length; p++, i += 4) {
    const v = img.data[p];
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  return rgba;
}

/** 左上からの累積和（積分画像）。領域の平均を O(1) で求めるのに使う */
function integralImage(img: GrayImage): Float64Array {
  const { width: w, height: h, data } = img;
  const iw = w + 1;
  const ii = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += data[y * w + x];
      ii[(y + 1) * iw + (x + 1)] = ii[y * iw + (x + 1)] + rowSum;
    }
  }
  return ii;
}

/**
 * 局所適応二値化。周辺 win×win の平均より C 以上暗い画素を黒(0)、
 * それ以外を白(255)にする。影・照明ムラに強い。
 */
export function adaptiveBinarize(
  img: GrayImage,
  win: number,
  C: number
): GrayImage {
  const { width: w, height: h, data } = img;
  const ii = integralImage(img);
  const iw = w + 1;
  const r = Math.floor(win / 2);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const area = (y1 - y0) * (x1 - x0);
      const sum =
        ii[y1 * iw + x1] - ii[y0 * iw + x1] - ii[y1 * iw + x0] + ii[y0 * iw + x0];
      const p = y * w + x;
      out[p] = data[p] > sum / area - C ? 255 : 0;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * OCR 用の前処理（カメラ枠の読み取りと同じ手順）。
 *   1. コントラスト強調
 *   2. 二値化（adaptive: 局所適応 / global: 固定しきい値）
 * threshold は調整パネルのしきい値スライダー、thresholdOffset はパスごとの増減。
 */
export function preprocessForOcr(
  gray: GrayImage,
  options: {
    threshold: number;
    thresholdOffset?: number;
    method?: "adaptive" | "global";
  }
): GrayImage {
  const { width: w, height: h } = gray;
  const thresholdOffset = options.thresholdOffset ?? 0;

  // Step 1: コントラスト強調
  const contrast = new Uint8ClampedArray(w * h);
  for (let p = 0; p < contrast.length; p++) {
    contrast[p] = ((gray.data[p] / 255 - 0.5) * 1.5 + 0.5) * 255;
  }
  const enhanced = { width: w, height: h, data: contrast };

  // Step 2: 二値化
  if (options.method === "global") {
    const threshold = options.threshold + thresholdOffset;
    const out = new Uint8ClampedArray(w * h);
    for (let p = 0; p < out.length; p++) {
      out[p] = contrast[p] > threshold ? 255 : 0;
    }
    return { width: w, height: h, data: out };
  }

  // C はスライダーとパスoffsetで微調整（暗側に倒すほど黒が増える）
  const manualBias = options.threshold - 120;
  const C = 12 + manualBias * 0.15 + thresholdOffset * 0.4;
  // 近傍ウィンドウ（枠の高さに比例、最低 15px）
  const win = Math.max(15, Math.floor(h / 4) | 1);
  return adaptiveBinarize(enhanced, win, C);
}

/**
 * 画像を縮小する（面積平均）。scale は 0〜1。
 * 写真全体から文字の並びを探すときに、処理を軽くするために使う。
 */
export function downscaleGray(img: GrayImage, scale: number): GrayImage {
  if (scale >= 1) return img;
  const ow = Math.max(1, Math.round(img.width * scale));
  const oh = Math.max(1, Math.round(img.height * scale));
  const fx = img.width / ow;
  const fy = img.height / oh;
  const out = new Uint8ClampedArray(ow * oh);
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * fy)));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * fx)));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * img.width;
        for (let xx = x0; xx < x1; xx++) sum += img.data[row + xx];
      }
      out[y * ow + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return { width: ow, height: oh, data: out };
}

/**
 * 傾いた長方形の範囲を切り出して、まっすぐな画像にする（双線形補間）。
 * cx, cy: 中心、angle: 傾き（ラジアン、右下がりが正）、
 * width, height: 元画像での大きさ、scale: 出力の拡大倍率。
 */
export function extractRotatedRect(
  img: GrayImage,
  rect: { cx: number; cy: number; angle: number; width: number; height: number },
  scale: number
): GrayImage {
  const ow = Math.max(1, Math.round(rect.width * scale));
  const oh = Math.max(1, Math.round(rect.height * scale));
  const out = new Uint8ClampedArray(ow * oh);
  const cos = Math.cos(rect.angle);
  const sin = Math.sin(rect.angle);
  const { width: W, height: H, data } = img;

  for (let y = 0; y < oh; y++) {
    const v = (y + 0.5) / scale - rect.height / 2;
    for (let x = 0; x < ow; x++) {
      const u = (x + 0.5) / scale - rect.width / 2;
      const sx = rect.cx + u * cos - v * sin - 0.5;
      const sy = rect.cy + u * sin + v * cos - 0.5;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= W - 1 || iy >= H - 1) {
        out[y * ow + x] = 255; // 画像の外は白
        continue;
      }
      const ax = sx - ix;
      const ay = sy - iy;
      const p = iy * W + ix;
      const top = data[p] * (1 - ax) + data[p + 1] * ax;
      const bottom = data[p + W] * (1 - ax) + data[p + W + 1] * ax;
      out[y * ow + x] = top * (1 - ay) + bottom * ay;
    }
  }
  return { width: ow, height: oh, data: out };
}
