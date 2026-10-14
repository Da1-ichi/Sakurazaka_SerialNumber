/**
 * 字形の照合による 1 文字ずつの判定。
 *
 * シリアルは毎回同じ等幅フォントで印刷されているため、文字ごとの「平均の形」
 * （glyphTemplates.ts）と見比べるだけで、Tesseract よりずっと正確に読める
 * （写真 4 枚・90 件での試験: Tesseract 72 件、字形の照合 88 件が正解）。
 * ただしフォントが変わると当たらなくなるので、似ている度合いが低いときは
 * 使わずに Tesseract に任せる。
 */
import { GLYPH_TEMPLATE_CHARS, GLYPH_TEMPLATE_DATA } from "./glyphTemplates";
import { GLYPH_H, GLYPH_W, glyphVector, segmentCharacters } from "./batch";
import type { CharBox } from "./batch";
import type { GrayImage } from "./image";

/** 1 文字ぶんの判定結果 */
export type GlyphGuess = {
  /** いちばん似ている文字 */
  char: string;
  /** その似ている度合い（-1〜1、1 が完全一致） */
  score: number;
  /** 2 番目に似ている文字 */
  second: string;
  /** 1 位と 2 位の差。小さいほど迷っている */
  margin: number;
};

/**
 * 1 位と 2 位の差がこれ未満の文字は「迷っている」とみなす。
 * 試験では、間違えた 2 文字はどちらも 0.035 未満、正解した文字の 99% は 0.17 以上。
 */
export const GLYPH_MARGIN_MIN = 0.08;
/** 1 位の似ている度合いがこれ未満の文字も「迷っている」とみなす */
export const GLYPH_SCORE_MIN = 0.75;
/**
 * 行全体の似ている度合い（中央値）がこれ未満なら、フォントが違うとみなして
 * 字形の照合を使わない（試験では正しい文字の 99% が 0.84 以上）。
 */
export const GLYPH_LINE_SCORE_MIN = 0.7;

let templates: Map<string, Float32Array> | null = null;

/** 埋め込みの字形データを読み込む（初回だけ） */
function getTemplates(): Map<string, Float32Array> {
  if (templates) return templates;
  const bin = atob(GLYPH_TEMPLATE_DATA);
  const size = GLYPH_W * GLYPH_H;
  const map = new Map<string, Float32Array>();
  [...GLYPH_TEMPLATE_CHARS].forEach((ch, k) => {
    const v = new Float32Array(size);
    let norm = 0;
    for (let i = 0; i < size; i++) {
      // 符号付き 8 ビットに戻す
      const byte = bin.charCodeAt(k * size + i);
      v[i] = byte > 127 ? byte - 256 : byte;
      norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < size; i++) v[i] /= norm;
    map.set(ch, v);
  });
  templates = map;
  return map;
}

/** 試験用: 字形データを差し替える（null で埋め込みのものに戻す） */
export function setGlyphTemplatesForTest(map: Map<string, Float32Array> | null) {
  templates = map;
}

/** 字形の特徴を、有効文字の中でいちばん似ている文字に当てる */
export function classifyGlyph(
  vec: Float32Array,
  validChars: Set<string>
): GlyphGuess {
  let best = "";
  let bestScore = -Infinity;
  let second = "";
  let secondScore = -Infinity;
  for (const [ch, t] of getTemplates()) {
    if (!validChars.has(ch)) continue;
    let s = 0;
    for (let i = 0; i < t.length; i++) s += t[i] * vec[i];
    if (s > bestScore) {
      second = best;
      secondScore = bestScore;
      best = ch;
      bestScore = s;
    } else if (s > secondScore) {
      second = ch;
      secondScore = s;
    }
  }
  return {
    char: best,
    score: bestScore,
    second,
    margin: second ? bestScore - secondScore : 1,
  };
}

/** 字形の照合で 1 行を読んだ結果 */
export type GlyphLineResult = {
  code: string;
  guesses: GlyphGuess[];
  /** 迷っている文字の位置（0 始まり） */
  uncertain: number[];
};

/**
 * 切り出した 1 行（gray: 元の濃淡、bin: 二値化したもの）を字形の照合で読む。
 * 文字がちょうど 13 個に分けられないときや、フォントが違いそうなときは null。
 */
export function readLineByGlyphs(
  gray: GrayImage,
  bin: GrayImage,
  charHeight: number,
  validChars: Set<string>,
  length = 13
): GlyphLineResult | null {
  const boxes: CharBox[] = segmentCharacters(bin, charHeight);
  if (boxes.length !== length) return null;

  // 行の文字の上端・下端（字ごとのばらつきに引きずられないよう中央値）
  const mid = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const top = mid(boxes.map((b) => b.y0));
  const bottom = mid(boxes.map((b) => b.y1));

  const guesses = boxes.map((b) =>
    classifyGlyph(glyphVector(gray, b, top, bottom), validChars)
  );
  if (mid(guesses.map((g) => g.score)) < GLYPH_LINE_SCORE_MIN) return null;

  const uncertain = guesses
    .map((g, i) => (g.margin < GLYPH_MARGIN_MIN || g.score < GLYPH_SCORE_MIN ? i : -1))
    .filter((i) => i >= 0);
  return { code: guesses.map((g) => g.char).join(""), guesses, uncertain };
}

/**
 * 字形の照合の結果に、Tesseract の読み（13 桁）を突き合わせる。
 * 迷っている位置で、Tesseract の文字が字形の 2 位と同じならそちらに入れ替える。
 *
 * 迷う組み合わせ（Z と 2、S と 5 と 8 など）は Tesseract も同じように間違えるため、
 * Tesseract と一致しても確信ありとはせず、迷っている位置はすべて uncertain に残す
 * （試験では、一致を理由に確信ありとした文字に誤りが出た）。
 */
export function resolveWithOcr(
  glyph: GlyphLineResult,
  ocrCode: string | undefined
): { code: string; uncertain: number[] } {
  const chars = [...glyph.code];
  for (const i of glyph.uncertain) {
    const o = ocrCode && ocrCode.length === chars.length ? ocrCode[i] : "";
    if (o && o === glyph.guesses[i].second) chars[i] = o;
  }
  return { code: chars.join(""), uncertain: [...glyph.uncertain] };
}
