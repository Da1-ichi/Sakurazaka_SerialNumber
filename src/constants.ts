import type { CropSettings } from "./types";

export const SERIAL_REGEX = /[A-Z0-9]{13}/g;
export const FIXED_SUFFIX = "T";
/** シングルごとに変わる末尾パターン（将来 UI で可変にする想定） */
export const CURRENT_SINGLE_SUFFIX = "WT";
export const STORAGE_KEY = "serial-reader-items";
export const CROP_SETTINGS_KEY = "serial-reader-crop-settings";

/**
 * 実物のシリアル番号で使われている文字セット:
 *   数字: 3 4 5 6 7 8 9  （0, 1, 2 は未使用）
 *   英字: A-H, J-N, P-Z  （I, O は未使用）
 */
export const VALID_CHARS = new Set("3456789ABCDEFGHJKLMNPQRSTUVWXYZ".split(""));

/**
 * OCR で互いに混同されやすい文字ペア（実測データより）。
 * 両方とも有効文字なので、Tesseract のホワイトリストだけでは解決できない。
 * 位置ごとに両方の可能性を展開して候補を生成する。
 */
export const CONFUSION_PAIRS: Record<string, string[]> = {
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

export const BOOKMARKLET_CODE = [
  "javascript:void(async function(){",
  "try{",
  "var text;",
  "try{text=await navigator.clipboard.readText()}",
  'catch(e){text=window.prompt("シリアルを貼り付けてください（改行区切り）")}',
  'if(!text){alert("入力がありません");return}',
  "var serials=text.split(/[\\n\\s,;]+/).map(function(s){return s.trim()}).filter(function(s){return /^[A-Z0-9]{13}$/.test(s)}).slice(0,10);",
  'if(serials.length===0){alert("有効なシリアルが見つかりませんでした");return}',
  "var inputs=Array.from(document.querySelectorAll('input[type=\"text\"],input:not([type])')).filter(function(el){var st=getComputedStyle(el);return st.display!==\"none\"&&st.visibility!==\"hidden\"&&el.offsetParent!==null});",
  'if(inputs.length===0){alert("入力欄が見つかりませんでした");return}',
  "var f=0;",
  "for(var i=0;i<serials.length&&i<inputs.length;i++){",
  "var inp=inputs[i];",
  'Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(inp,serials[i]);',
  'inp.dispatchEvent(new Event("input",{bubbles:true}));',
  'inp.dispatchEvent(new Event("change",{bubbles:true}));',
  "f++}",
  'alert(f+"件入力しました")',
  '}catch(e){alert("失敗しました: "+e.message)}',
  "}())",
].join("");
