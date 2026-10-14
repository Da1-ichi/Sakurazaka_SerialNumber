/**
 * 写真 1 枚から複数のシリアルを読む流れ（canvas や OCR エンジンには依存しない）。
 *
 *   1. detectSerialLines で、シリアルらしい行を探す
 *   2. 行ごとに、元の解像度でまっすぐに切り出す（文字の高さを LINE_CHAR_HEIGHT にそろえる）
 *   3. 字形の照合で読む。迷った文字があるとき・照合できないときだけ OCR にかける
 *   4. それでも迷う文字が残った行は「要確認」にする
 */
import { detectSerialLines, lineCropRect } from "./batch";
import type { SerialLine } from "./batch";
import { extractRotatedRect, preprocessForOcr } from "./image";
import type { GrayImage } from "./image";
import { readLineByGlyphs, resolveWithOcr } from "./glyphMatch";

/** 切り出した行の、文字の高さ（画素）。照合・OCR ともこの大きさで行う */
export const LINE_CHAR_HEIGHT = 48;

/** 1 行ぶんの読み取り結果 */
export type PhotoLineResult = {
  /** 読み取ったシリアル（読めなかったときは空文字） */
  code: string;
  /** 迷っている文字の位置（0 始まり）。空なら確信あり */
  uncertain: number[];
  /** 迷っている位置ごとの、ありそうな文字（良い順） */
  hints: { index: number; options: string[] }[];
  /** どの方法で決めたか */
  method: "glyph" | "glyph+ocr" | "ocr" | "none";
  /** まっすぐに切り出した行の画像（確認表示用） */
  image: GrayImage;
  line: SerialLine;
};

export type PhotoReadOptions = {
  validChars: Set<string>;
  /** 二値化の調整（カメラ枠の調整パネルのしきい値と同じもの） */
  threshold: number;
  /**
   * 前処理済みの行画像を OCR にかけ、候補（良い順、13 桁）を返す。
   * 複数の前処理（パス）をまとめて渡すので、投票して 1 つの候補列にすること。
   */
  ocr: (passImages: GrayImage[]) => Promise<string[]>;
  /** OCR に渡す前処理の種類（thresholdOffset の一覧） */
  ocrPassOffsets: number[];
  /** 進み具合の通知（done 行 / total 行） */
  onProgress?: (done: number, total: number, needsOcr: boolean) => void;
  /** OCR に失敗したとき（読み取りは続ける） */
  onOcrError?: (error: unknown) => void;
};

/** 写真（元の解像度のグレースケール）から、シリアルをまとめて読む */
export async function readSerialsFromPhoto(
  photo: GrayImage,
  options: PhotoReadOptions
): Promise<PhotoLineResult[]> {
  const lines = detectSerialLines(photo);
  const results: PhotoLineResult[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const crop = extractRotatedRect(
      photo,
      lineCropRect(line),
      LINE_CHAR_HEIGHT / line.charHeight
    );
    const bin = preprocessForOcr(crop, { threshold: options.threshold });
    const glyph = readLineByGlyphs(crop, bin, LINE_CHAR_HEIGHT, options.validChars);

    // 字形の照合で迷いなく読めたら、OCR はかけない（速い）
    if (glyph && glyph.uncertain.length === 0) {
      results.push({
        code: glyph.code,
        uncertain: [],
        hints: [],
        method: "glyph",
        image: crop,
        line,
      });
      options.onProgress?.(i + 1, lines.length, false);
      continue;
    }

    options.onProgress?.(i, lines.length, true);
    const passImages = options.ocrPassOffsets.map((offset) =>
      preprocessForOcr(crop, { threshold: options.threshold, thresholdOffset: offset })
    );
    let ocrCandidates: string[] = [];
    try {
      ocrCandidates = await options.ocr(passImages);
    } catch (error) {
      // OCR に失敗しても止めない（字形の照合の結果があればそれを出す）
      console.error(error);
      options.onOcrError?.(error);
    }
    const ocrTop = ocrCandidates.find((c) => c.length === 13);

    if (glyph) {
      const resolved = resolveWithOcr(glyph, ocrTop);
      const hints = resolved.uncertain.map((index) => {
        const g = glyph.guesses[index];
        const options = [resolved.code[index], g.char, g.second];
        return { index, options: [...new Set(options.filter(Boolean))] };
      });
      results.push({ ...resolved, hints, method: "glyph+ocr", image: crop, line });
    } else if (ocrTop) {
      // 照合できない行（文字が 13 個に分けられない・フォントが違う）は OCR だけで決める。
      // 確信が持てないので、全体を要確認にする
      results.push({
        code: ocrTop,
        uncertain: [...ocrTop].map((_, k) => k),
        hints: [],
        method: "ocr",
        image: crop,
        line,
      });
    } else {
      results.push({
        code: "",
        uncertain: [],
        hints: [],
        method: "none",
        image: crop,
        line,
      });
    }
    options.onProgress?.(i + 1, lines.length, true);
  }
  return results;
}
