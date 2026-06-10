import {
  SERIAL_REGEX,
  FIXED_SUFFIX,
  CURRENT_SINGLE_SUFFIX,
  VALID_CHARS,
  CONFUSION_PAIRS,
  MAX_DISPLAY_CANDIDATES,
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

export function scoreCandidate(
  code: string,
  occurrenceCount = 0,
  isVoted = false
): number {
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

  // 複数パスで同一の生候補が出現したら強い証拠 → 大幅加点
  if (occurrenceCount >= 2) score += occurrenceCount * 40;

  // 位置投票で組み立てられた候補は特に信頼度が高い
  if (isVoted) score += 60;

  return score;
}

/**
 * OCR テキストから 13 桁の生候補を抽出する（曖昧展開はしない）。
 * 多パス OCR では各パスのテキストに対してこれを呼び、結果をまとめて集約する。
 */
export function extractRawSerials(text: string): string[] {
  const normalized = normalizeText(text);
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

  return [...rawCandidates];
}

/**
 * 複数の 13 桁生候補から、各位置で多数決を取って 1 つの「投票結果コード」を作る。
 * 例: ["ZJ4RABCETP89V", "ZJ4RABCET989V", "ZJ4RABCETP89V"] の 11 文字目は
 *      P, 9, P → 多数決で P が選ばれる。
 * 候補が 2 つ未満なら投票しない（信頼性が低いため）。
 */
export function voteByPosition(rawCandidates: string[]): string | null {
  const length13 = rawCandidates.filter((c) => c.length === 13);
  if (length13.length < 2) return null;

  const result: string[] = [];
  for (let pos = 0; pos < 13; pos++) {
    const counts = new Map<string, number>();
    for (const c of length13) {
      const ch = c[pos];
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    let best = "";
    let bestCount = 0;
    for (const [ch, n] of counts) {
      if (n > bestCount) {
        best = ch;
        bestCount = n;
      }
    }
    result.push(best);
  }
  return result.join("");
}

/**
 * 多パスの生候補リストから、位置投票＋曖昧文字展開＋スコアリングで
 * 最終候補リストを生成する。
 */
export function aggregateCandidates(rawCandidatesAllPasses: string[]): string[] {
  // 生候補の出現回数を集計（複数パスで一致したら高信頼）
  const occurrence = new Map<string, number>();
  for (const raw of rawCandidatesAllPasses) {
    occurrence.set(raw, (occurrence.get(raw) ?? 0) + 1);
  }

  // 位置投票で代表候補を作る
  const voted = voteByPosition(rawCandidatesAllPasses);
  const votedSet = new Set<string>();
  if (voted) votedSet.add(voted);

  // 各生候補を曖昧文字展開してスコアリング
  const scored = new Map<string, number>();

  for (const [raw, count] of occurrence.entries()) {
    const variants = expandAmbiguous(raw);
    for (const v of variants) {
      // 元の生候補と一致するバリアントには出現回数を反映
      const matchedOccurrence = v === raw ? count : 0;
      const isVoted = votedSet.has(v);
      const s = scoreCandidate(v, matchedOccurrence, isVoted);
      scored.set(v, Math.max(scored.get(v) ?? 0, s));
    }
  }

  // 投票結果も独立して評価（生候補に含まれない可能性があるため）
  if (voted) {
    const variants = expandAmbiguous(voted);
    for (const v of variants) {
      const isVoted = v === voted;
      const s = scoreCandidate(v, occurrence.get(v) ?? 0, isVoted);
      scored.set(v, Math.max(scored.get(v) ?? 0, s));
    }
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DISPLAY_CANDIDATES)
    .map(([value]) => value);
}

/**
 * 単一のテキストから候補を生成する後方互換用ラッパー。
 */
export function extractSerialCandidates(text: string): string[] {
  return aggregateCandidates(extractRawSerials(text));
}

// ─── 第二層: legacy エンジンの symbol 単位データを使った集約 ──────────────

/** Tesseract legacy が返す 1 文字ぶんの認識結果 */
export type OcrSymbol = {
  /** 第一候補の文字 */
  char: string;
  /** 第一候補の確信度 (0-100) */
  conf: number;
  /** 代替候補（char と conf のペア）。legacy のみ取得可能 */
  choices: { t: string; cf: number }[];
};

/** 確信度がこれ未満の端の文字は枠線・ノイズとみなして窓選択から除外 */
const EDGE_NOISE_CONF = 40;

/**
 * 1 パスぶんの symbol 列から「確信度合計が最大の連続 13 文字窓」を選ぶ。
 * legacy は PSM 7 で行の前後にゴミ（低確信の枠線など）を拾うため、
 * 単純な先頭/末尾切り出しではなく、最も「文字らしい」13 連続を探す。
 */
export function bestSerialWindow(symbols: OcrSymbol[]): OcrSymbol[] | null {
  // 端の極端に低確信な文字をまず削る（中間は残す）
  let s = [...symbols];
  while (s.length > 13 && s[0].conf < EDGE_NOISE_CONF) s.shift();
  while (s.length > 13 && s[s.length - 1].conf < EDGE_NOISE_CONF) s.pop();

  if (s.length < 13) return null;
  if (s.length === 13) return s;

  let best: OcrSymbol[] | null = null;
  let bestScore = -1;
  for (let i = 0; i + 13 <= s.length; i++) {
    const win = s.slice(i, i + 13);
    let score = win.reduce((a, x) => a + x.conf, 0);
    // 末尾サフィックス（WT 等）が窓の末尾に来る並びを優遇
    const tail = win.map((x) => x.char).join("");
    if (tail.endsWith(CURRENT_SINGLE_SUFFIX)) score += 300;
    else if (tail.endsWith(FIXED_SUFFIX)) score += 150;
    if (score > bestScore) {
      bestScore = score;
      best = win;
    }
  }
  return best;
}

/**
 * 複数パスの symbol 列から、確信度＋代替候補の重み付き投票で最終候補を作る。
 *
 * 各パスを bestSerialWindow で 13 桁に揃えたうえで、位置ごとに
 *   - 第一候補: 確信度をそのまま加点
 *   - 代替候補(choices): 確信度を割り引いて加点（エンジンが実際に迷った候補のみ）
 * を集計し、各位置のトップ文字を採用する。さらに上位の揺れている位置を
 * 展開して候補リストを作り、scoreCandidate で順位付けする。
 *
 * これにより、ハードコードした CONFUSION_PAIRS ではなく
 * 「エンジンが実際に挙げた候補」で曖昧さを解消できる。
 */
export function aggregateBySymbols(
  perPassSymbols: OcrSymbol[][]
): string[] {
  const windows = perPassSymbols
    .map(bestSerialWindow)
    .filter((w): w is OcrSymbol[] => w !== null);

  if (windows.length === 0) return [];

  // 代替候補の重み（第一候補=1.0 に対する割引率）
  const CHOICE_WEIGHT = 0.5;

  // 各位置ごとに { 文字 -> 累積スコア } を作る
  const perPosition: Map<string, number>[] = [];
  for (let pos = 0; pos < 13; pos++) {
    const score = new Map<string, number>();
    for (const win of windows) {
      const sym = win[pos];
      if (!sym) continue;
      const add = (ch: string, v: number) =>
        score.set(ch, (score.get(ch) ?? 0) + v);
      add(sym.char, sym.conf);
      for (const c of sym.choices) {
        if (c.t !== sym.char) add(c.t, c.cf * CHOICE_WEIGHT);
      }
    }
    perPosition.push(score);
  }

  // 各位置の上位候補（最大2つ）を取り出す
  const topPerPosition = perPosition.map((score) => {
    const sorted = [...score.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 2).map(([ch]) => ch);
  });

  // 第一候補を並べた「投票コード」
  const votedCode = topPerPosition.map((c) => c[0] ?? "").join("");

  // 揺れている位置（2候補のスコアが拮抗）だけを展開して候補を増やす。
  // 全位置を展開すると爆発するので、上位2位が僅差の位置に限定する。
  const candidates = new Set<string>();
  candidates.add(votedCode);

  const ambiguousPositions: number[] = [];
  perPosition.forEach((score, pos) => {
    const sorted = [...score.values()].sort((a, b) => b - a);
    if (sorted.length >= 2 && sorted[1] > sorted[0] * 0.6) {
      ambiguousPositions.push(pos);
    }
  });

  // 曖昧位置の組み合わせを展開（多すぎる場合は上位 4 箇所まで）
  const limited = ambiguousPositions.slice(0, 4);
  const expandCount = 1 << limited.length;
  for (let mask = 0; mask < expandCount && candidates.size < 32; mask++) {
    const chars = [...votedCode];
    limited.forEach((pos, bit) => {
      if (mask & (1 << bit)) {
        const alt = topPerPosition[pos][1];
        if (alt) chars[pos] = alt;
      }
    });
    candidates.add(chars.join(""));
  }

  // scoreCandidate で順位付け（末尾サフィックス・有効文字などを加味）
  const scored = [...candidates].map((code) => {
    const isVoted = code === votedCode;
    return { code, score: scoreCandidate(code, 0, isVoted) };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DISPLAY_CANDIDATES)
    .map((x) => x.code);
}
