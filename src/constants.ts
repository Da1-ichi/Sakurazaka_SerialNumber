import type { CropSettings } from "./types";

export const SERIAL_REGEX = /[A-Z0-9]{13}/g;
export const SERIAL_LENGTH = 13;
export const STORAGE_KEY = "serial-reader-items";
export const CROP_SETTINGS_KEY = "serial-reader-crop-settings";
/** シングルごとの設定（末尾・有効文字・何枚目） */
export const FORMAT_SETTINGS_KEY = "serial-reader-format-settings";
/** 画面まわりの設定（連続スキャン間隔・調整パネルの表示） */
export const UI_SETTINGS_KEY = "serial-reader-ui-settings";

/**
 * シングルごとに変わる読み取り条件。
 * 末尾はシングルごとに違い（14th は 9V、15th は WT）、
 * 使われる文字も前提どおりとは限らない（15th には数字の 2 がある）ため、
 * コードに直書きせず画面から変えられるようにしている。
 */
export type FormatSettings = {
  /** シリアルの末尾。一致した候補を優先する。空なら末尾の加点なし */
  suffix: string;
  /** シリアルに使われる文字。OCR の認識文字・正規化・採点に使う */
  validChars: string;
  /** 何枚目のシングルか。応募ページの URL はここから作る */
  singleNumber: number;
};

/** 0・1・I・O を除いた英数字。15th の実物に 2 があるため 2 は含める */
export const DEFAULT_VALID_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** 初期値は 15th シングル「Lonesome rabbit / What's "KAZOKU"?」 */
export const DEFAULT_FORMAT_SETTINGS: FormatSettings = {
  suffix: "WT",
  validChars: DEFAULT_VALID_CHARS,
  singleNumber: 15,
};

export const SINGLE_NUMBER_MIN = 1;
export const SINGLE_NUMBER_MAX = 99;

/** 英語の序数の接尾辞（1st・2nd・3rd・11th・21st …） */
function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/** シングルの枚数を有効な整数にそろえる。不正なら null */
export function sanitizeSingleNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < SINGLE_NUMBER_MIN || n > SINGLE_NUMBER_MAX) return null;
  return n;
}

/** 例: 15 → https://ticket.fortunemeets.app/sakurazaka46/15th#/ */
export function buildTargetUrl(singleNumber: number): string {
  return `https://ticket.fortunemeets.app/sakurazaka46/${singleNumber}${ordinalSuffix(singleNumber)}#/`;
}

/** 旧設定の応募 URL から枚数を取り出す（移行用） */
export function singleNumberFromUrl(url: string): number | null {
  const m = url.match(/\/sakurazaka46\/(\d+)(?:st|nd|rd|th)\b/);
  return m ? sanitizeSingleNumber(Number(m[1])) : null;
}

export type UiSettings = {
  autoScanIntervalMs: number;
  showAdjuster: boolean;
};

export const DEFAULT_UI_SETTINGS: UiSettings = {
  autoScanIntervalMs: 1200,
  showAdjuster: true,
};

export const AUTO_SCAN_INTERVAL_MIN = 800;
export const AUTO_SCAN_INTERVAL_MAX = 5000;
/** 候補が出なかったときの最短待ち時間 */
export const AUTO_SCAN_EMPTY_DELAY_MS = 1600;

/** 入力された末尾を英大文字・数字だけに整える（最大 12 文字） */
export function sanitizeSuffix(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, SERIAL_LENGTH - 1);
}

/** 入力された有効文字を英大文字・数字だけにし、重複を除いて並べ替える */
export function sanitizeValidChars(value: string): string {
  const chars = new Set(value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  return [...chars].sort().join("");
}

/**
 * 実際に使う有効文字の集合。
 * 空のときは全滅を避けるため初期値を使い、末尾の文字は必ず含める
 * （末尾に有効文字外の文字があると、末尾一致の候補が出なくなるため）。
 */
export function resolveValidChars(settings: FormatSettings): Set<string> {
  const base = sanitizeValidChars(settings.validChars) || DEFAULT_VALID_CHARS;
  return new Set([...base, ...sanitizeSuffix(settings.suffix)]);
}

/**
 * OCR で互いに混同されやすい文字ペア（実測データより）。
 * 両方とも有効文字なので、Tesseract のホワイトリストだけでは解決できない。
 * 位置ごとに両方の可能性を展開して候補を生成する。
 * 有効文字に含まれない文字への展開は ocr.ts 側で除外する。
 */
export const CONFUSION_PAIRS: Record<string, string[]> = {
  Z: ["Z", "2"],
  "2": ["2", "Z"],
  S: ["S", "5"],
  "5": ["5", "S"],
  "9": ["9", "P", "S", "G"],
  P: ["P", "9"], // P ↔ 9（追加）
  B: ["B", "8"],
  "8": ["8", "B"],
  E: ["E", "F"],
  F: ["F", "E"],
  G: ["G", "9", "6"],
  "6": ["6", "G"],
};

/** 画像拡大倍率。Tesseract は文字が大きいほど精度が上がる */
export const UPSCALE_FACTOR = 3;

/**
 * OCR に渡す画像の幅の上限（画素）。
 * 4K 映像を 3 倍にすると幅が数千画素になり、スマホではメモリ不足で
 * 認識エンジンが落ちることがある。文字の大きさとしても十分なので、
 * これを超える場合は拡大倍率を下げる（元の大きさより小さくはしない）。
 */
export const MAX_OCR_IMAGE_WIDTH = 2400;

/**
 * 認識エンジンの準備（初回は約23MBのダウンロードを含む）を待つ上限。
 * これを超えたら失敗として扱い、もう一度読み取れるようにする。
 */
export const WORKER_INIT_TIMEOUT_MS = 120_000;

/** 表示する候補の最大件数（多すぎると選びにくいので絞る） */
export const MAX_DISPLAY_CANDIDATES = 10;

/**
 * 多パス OCR の前処理設定。
 * 二値化方式を method で切り替える:
 *   "adaptive" = 局所適応二値化（影・照明ムラに強い。各ピクセル周辺の平均で判定）
 *   "global"   = グローバル固定二値化（影のない均一照明用。現状未使用）
 * グローバルは影が強い場面で画像全体が潰れ、その壊れた結果が投票を
 * 汚染するため、既定では局所適応のみを使う。thresholdOffset は
 * adaptive では判定オフセット C を増減させる（大きいほど黒が減る）。
 */
export type PassConfig = {
  thresholdOffset: number;
  method?: "adaptive" | "global";
};

/** 連続スキャン時の軽量パス（処理時間優先） */
export const QUICK_PASSES: PassConfig[] = [
  { thresholdOffset: 0, method: "adaptive" },
  { thresholdOffset: 20, method: "adaptive" },
];

/**
 * 手動シャッター時の高精度パス（精度優先）。
 * 局所適応を C 違いで5本。C が小さいほど薄い線も黒く拾い、
 * 大きいほどノイズを抑える。影の濃淡・線の太さの違いを投票でカバー。
 */
export const ACCURATE_PASSES: PassConfig[] = [
  { thresholdOffset: -20, method: "adaptive" },
  { thresholdOffset: -5, method: "adaptive" },
  { thresholdOffset: 10, method: "adaptive" },
  { thresholdOffset: 25, method: "adaptive" },
  { thresholdOffset: 40, method: "adaptive" },
];

export const DEFAULT_CROP_SETTINGS: CropSettings = {
  x: 0.2,
  y: 0.5,
  width: 0.65,
  height: 0.085,
  threshold: 120,
};

/**
 * 応募サイトで実行するブックマークレットの本体。
 * 改行ごとに前後の空白を詰めて 1 行の javascript: URL にするため、
 * 文は必ずセミコロンで終え、行コメントや「%」「#」は使わないこと。
 *
 * 入力欄の選び方:
 *   1. 画面に見えていて書き込める text / tel / search の入力欄を集める
 *   2. そのうち maxlength=13、または name・id・placeholder・ラベルに
 *      「serial」「シリアル」「応募券」「code」「コード」を含む欄があれば、それだけを使う
 *      （検索窓や氏名欄に入ってしまうのを防ぐ）
 *   3. 対象の欄に空欄があれば空欄だけに入れる（11 件目以降を後から足せるように）
 */
const BOOKMARKLET_SOURCE = `
(async function(){
try{
var text;
try{text=await navigator.clipboard.readText();}
catch(e){text=window.prompt("シリアルを貼り付けてください（改行区切り）");}
if(!text){alert("入力がありません");return;}
var seen={};
var serials=text.split(/[\\n\\s,;]+/).map(function(s){return s.trim().toUpperCase();}).filter(function(s){if(!/^[A-Z0-9]{13}$/.test(s)||seen[s])return false;seen[s]=true;return true;});
if(serials.length===0){alert("有効なシリアルが見つかりませんでした");return;}
var all=Array.from(document.querySelectorAll("input")).filter(function(el){var t=(el.getAttribute("type")||"text").toLowerCase();if(["text","tel","search"].indexOf(t)<0)return false;if(el.disabled||el.readOnly)return false;var st=getComputedStyle(el);return st.display!=="none"&&st.visibility!=="hidden"&&el.offsetParent!==null;});
if(all.length===0){alert("入力欄が見つかりませんでした");return;}
var label=function(el){var l=el.labels&&el.labels[0]?el.labels[0].textContent:"";return [el.name,el.id,el.placeholder,el.getAttribute("aria-label"),l].join(" ");};
var hit=all.filter(function(el){return el.maxLength===13||/serial|シリアル|応募券|code|コード/i.test(label(el));});
var targets=hit.length>0?hit:all;
var empty=targets.filter(function(el){return !el.value;});
if(empty.length>0)targets=empty;
var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
var f=0;
for(var i=0;i<serials.length&&i<targets.length;i++){
var inp=targets[i];
setter.call(inp,serials[i]);
inp.dispatchEvent(new Event("input",{bubbles:true}));
inp.dispatchEvent(new Event("change",{bubbles:true}));
f++;
}
var rest=serials.length-f;
var msg=f+"件入力しました";
if(hit.length===0)msg+="\\n（シリアル欄を特定できなかったため、ページ内の入力欄に上から入れました。位置を確認してください）";
if(rest>0)msg+="\\n入りきらなかったシリアルが"+rest+"件あります";
alert(msg);
}catch(e){alert("失敗しました: "+e.message);}
}());
`;

export const BOOKMARKLET_CODE =
  "javascript:void" +
  BOOKMARKLET_SOURCE.trim()
    .split("\n")
    .map((line) => line.trim())
    .join("")
    .replace(/;$/, "");
