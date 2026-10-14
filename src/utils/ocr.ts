import type { Block } from "tesseract.js";
import {
  SERIAL_REGEX,
  CONFUSION_PAIRS,
  MAX_DISPLAY_CANDIDATES,
} from "../constants";

/**
 * 候補の判定に使う、シングルごとのルール。
 * App 側で FormatSettings から作って渡す。
 */
export type SerialRules = {
  /** 末尾（空文字なら末尾の加点なし） */
  suffix: string;
  /** 有効文字の集合 */
  validChars: Set<string>;
};

/**
 * 有効文字に含まれないときだけ、形が近い文字へ置き換える対応表。
 * 例: 2 が有効文字なら 2 はそのまま残し、無効なら Z にする。
 */
const LOOKALIKE_FALLBACK: [string, string][] = [
  ["0", "D"],
  ["1", "L"],
  ["2", "Z"],
  ["O", "D"],
  ["I", "J"],
];

/**
 * OCR 生テキストの前処理。
 * 0・1・2・I・O は、有効文字に含まれない場合だけ形状が近い文字に確定変換する。
 */
export function normalizeText(text: string, validChars: Set<string>): string {
  let s = text
    .toUpperCase()
    .replace(/[Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // 記号の誤認識
    .replace(/[$(]/g, "S")
    .replace(/[!|]/g, "L")
    .replace(/[{}[\]]/g, "")
    .replace(/[#]/g, "H")
    .replace(/[@]/g, "A")
    .replace(/[&]/g, "8");

  // 無効文字の確定変換（有効文字に入っている文字は変換しない）
  for (const [from, to] of LOOKALIKE_FALLBACK) {
    if (!validChars.has(from)) s = s.split(from).join(to);
  }

  return s
    // 空白・区切り文字を除去
    .replace(/[\s\-—_\.,:;'"`~]/g, "")
    // 英数字以外 → スペース
    .replace(/[^A-Z0-9]/g, " ");
}

/**
 * 13 桁の候補に対して、曖昧な位置を展開し全バリアントを生成する。
 * 候補数爆発を防ぐため最大 64 個に制限。
 */
export function expandAmbiguous(
  code: string,
  validChars: Set<string>
): string[] {
  const MAX_VARIANTS = 64;
  let results = [""];

  for (const ch of code) {
    // 有効文字にない文字への展開は作らない（元の文字は必ず残す）
    const alternatives = (CONFUSION_PAIRS[ch] ?? [ch]).filter(
      (alt) => alt === ch || validChars.has(alt)
    );
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
  rules: SerialRules,
  occurrenceCount = 0,
  isVoted = false
): number {
  let score = 0;

  if (/^[A-Z0-9]{13}$/.test(code)) score += 100;

  // 末尾が設定値と一致（シングルごとに違うため、設定から受け取る）
  if (rules.suffix && code.endsWith(rules.suffix)) score += 100;

  // 有効文字セットのみで構成
  const allValid = [...code].every((ch) => rules.validChars.has(ch));
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
export function extractRawSerials(
  text: string,
  validChars: Set<string>
): string[] {
  const normalized = normalizeText(text, validChars);
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
export function aggregateCandidates(
  rawCandidatesAllPasses: string[],
  rules: SerialRules
): string[] {
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
    const variants = expandAmbiguous(raw, rules.validChars);
    for (const v of variants) {
      // 元の生候補と一致するバリアントには出現回数を反映
      const matchedOccurrence = v === raw ? count : 0;
      const isVoted = votedSet.has(v);
      const s = scoreCandidate(v, rules, matchedOccurrence, isVoted);
      scored.set(v, Math.max(scored.get(v) ?? 0, s));
    }
  }

  // 投票結果も独立して評価（生候補に含まれない可能性があるため）
  if (voted) {
    const variants = expandAmbiguous(voted, rules.validChars);
    for (const v of variants) {
      const isVoted = v === voted;
      const s = scoreCandidate(v, rules, occurrence.get(v) ?? 0, isVoted);
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
export function extractSerialCandidates(
  text: string,
  rules: SerialRules
): string[] {
  return aggregateCandidates(extractRawSerials(text, rules.validChars), rules);
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

/** blocks から 1 文字ずつの認識結果（確信度・代替候補つき）を平坦化して取り出す */
export function collectSymbols(blocks: Block[] | null): OcrSymbol[] {
  const syms: OcrSymbol[] = [];
  for (const block of blocks ?? []) {
    for (const par of block.paragraphs ?? []) {
      for (const line of par.lines ?? []) {
        for (const word of line.words ?? []) {
          for (const sym of word.symbols ?? []) {
            const ch = (sym.text ?? "").toUpperCase();
            if (!/[A-Z0-9]/.test(ch)) continue;
            syms.push({
              char: ch,
              conf: sym.confidence ?? 0,
              choices: (sym.choices ?? [])
                .map((c) => ({
                  t: (c.text ?? "").toUpperCase(),
                  cf: c.confidence ?? 0,
                }))
                .filter((c) => /^[A-Z0-9]$/.test(c.t)),
            });
          }
        }
      }
    }
  }
  return syms;
}

/** 確信度がこれ未満の端の文字は枠線・ノイズとみなして窓選択から除外 */
const EDGE_NOISE_CONF = 40;

/**
 * 1 パスぶんの symbol 列から「確信度合計が最大の連続 13 文字窓」を選ぶ。
 * legacy は PSM 7 で行の前後にゴミ（低確信の枠線など）を拾うため、
 * 単純な先頭/末尾切り出しではなく、最も「文字らしい」13 連続を探す。
 */
export function bestSerialWindow(
  symbols: OcrSymbol[],
  suffix: string
): OcrSymbol[] | null {
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
    // 末尾サフィックス（WT 等）が窓の末尾に来る並びを優遇。
    // 全体が一致しなくても、最後の 1 文字が合えば少し優遇する。
    if (suffix) {
      const tail = win.map((x) => x.char).join("");
      if (tail.endsWith(suffix)) score += 300;
      else if (tail.endsWith(suffix.slice(-1))) score += 150;
    }
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
  perPassSymbols: OcrSymbol[][],
  rules: SerialRules
): string[] {
  const windows = perPassSymbols
    .map((syms) => bestSerialWindow(syms, rules.suffix))
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
        // 有効文字にない代替候補は数えない
        if (c.t !== sym.char && rules.validChars.has(c.t)) {
          add(c.t, c.cf * CHOICE_WEIGHT);
        }
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
    return { code, score: scoreCandidate(code, rules, 0, isVoted) };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DISPLAY_CANDIDATES)
    .map((x) => x.code);
}
