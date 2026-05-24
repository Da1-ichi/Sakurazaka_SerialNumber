import {
  SERIAL_REGEX,
  FIXED_SUFFIX,
  CURRENT_SINGLE_SUFFIX,
  VALID_CHARS,
  CONFUSION_PAIRS,
} from "../constants";

/**
 * OCR 生テキストの前処理。
 * 無効文字（0,1,2,I,O）を形状が近い有効文字に確定変換する。
 */
export function normalizeText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // 記号の誤認識
    .replace(/[$(]/g, "S")
    .replace(/[!|]/g, "L")
    .replace(/[{}[\]]/g, "")
    .replace(/[#]/g, "H")
    .replace(/[@]/g, "A")
    .replace(/[&]/g, "8")
    // 無効文字の確定変換
    .replace(/0/g, "D")
    .replace(/1/g, "L")
    .replace(/2/g, "Z")
    .replace(/O/g, "D")
    .replace(/I/g, "J")
    // 空白・区切り文字を除去
    .replace(/[\s\-—_\.,:;'"`~]/g, "")
    // 英数字以外 → スペース
    .replace(/[^A-Z0-9]/g, " ");
}

/**
 * 13 桁の候補に対して、曖昧な位置を展開し全バリアントを生成する。
 * 候補数爆発を防ぐため最大 64 個に制限。
 */
export function expandAmbiguous(code: string): string[] {
  const MAX_VARIANTS = 64;
  let results = [""];

  for (const ch of code) {
    const alternatives = CONFUSION_PAIRS[ch] ?? [ch];
    const next: string[] = [];
    for (const prefix of results) {
      for (const alt of alternatives) {
        next.push(prefix + alt);
        if (next.length >= MAX_VARIANTS) break;
      }
      if (next.length >= MAX_VARIANTS) break;
    }
    results = next;
  }

  return [...new Set(results)];
}

export function scoreCandidate(code: string): number {
  let score = 0;

  if (/^[A-Z0-9]{13}$/.test(code)) score += 100;

  // 末尾 "V"（歴代共通）
  if (code.endsWith(FIXED_SUFFIX)) score += 80;

  // 末尾 "9V"（今回のシングル固有）
  if (code.endsWith(CURRENT_SINGLE_SUFFIX)) score += 100;

  // 有効文字セットのみで構成
  const allValid = [...code].every((ch) => VALID_CHARS.has(ch));
  if (allValid) score += 80;

  // 数字・アルファベット混在
  if (/\d/.test(code)) score += 10;
  if (/[A-Z]/.test(code)) score += 10;

  // 同一文字4連続以上はペナルティ
  if (!/(.)\1{3,}/.test(code)) score += 10;

  return score;
}

/**
 * OCR テキストから 13 桁候補を抽出し、曖昧文字を位置ごとに展開する。
 */
export function extractSerialCandidates(text: string): string[] {
  const normalized = normalizeText(text);

  // 13 桁の生候補を抽出
  const rawCandidates = new Set<string>();

  const directMatches = normalized.match(SERIAL_REGEX) ?? [];
  for (const m of directMatches) rawCandidates.add(m);

  const compact = normalized.replace(/\s+/g, "");
  for (let i = 0; i <= compact.length - 13; i++) {
    const chunk = compact.slice(i, i + 13);
    if (/^[A-Z0-9]{13}$/.test(chunk)) {
      rawCandidates.add(chunk);
    }
  }

  // 各生候補を曖昧文字展開してスコアリング
  const scored = new Map<string, number>();

  for (const raw of rawCandidates) {
    const variants = expandAmbiguous(raw);
    for (const v of variants) {
      const s = scoreCandidate(v);
      scored.set(v, Math.max(scored.get(v) ?? 0, s));
    }
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([value]) => value);
}
