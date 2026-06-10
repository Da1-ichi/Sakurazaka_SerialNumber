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
 * 1 枚の画像から複数の前処理バリアントを作り、それぞれ OCR して結果を投票で集約する。
 */
export type PassConfig = {
  thresholdOffset: number;
  sharpen?: boolean;
  morphology?: "thicken" | "thin" | null;
};

/** 連続スキャン時の軽量パス（処理時間優先） */
export const QUICK_PASSES: PassConfig[] = [
  { thresholdOffset: 0 },
  { thresholdOffset: 25 },
];

/** 手動シャッター時の高精度パス（精度優先） */
export const ACCURATE_PASSES: PassConfig[] = [
  { thresholdOffset: -20 },
  { thresholdOffset: 0 },
  { thresholdOffset: 0, sharpen: true },
  { thresholdOffset: 25 },
  { thresholdOffset: 0, morphology: "thicken" },
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
