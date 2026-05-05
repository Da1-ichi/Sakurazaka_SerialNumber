import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";

const SERIAL_REGEX = /[A-Z0-9]{13}/g;
const FIXED_SUFFIX = "V";
/** シングルごとに変わる末尾パターン（将来 UI で可変にする想定） */
const CURRENT_SINGLE_SUFFIX = "9V";
const STORAGE_KEY = "serial-reader-items";
const CROP_SETTINGS_KEY = "serial-reader-crop-settings";

/**
 * 実物のシリアル番号で使われている文字セット:
 *   数字: 3 4 5 6 7 8 9  （0, 1, 2 は未使用）
 *   英字: A-H, J-N, P-Z  （I, O は未使用）
 */
const VALID_CHARS = new Set("3456789ABCDEFGHJKLMNPQRSTUVWXYZ".split(""));

/**
 * OCR で互いに混同されやすい文字ペア（実測データより）。
 * 両方とも有効文字なので、Tesseract のホワイトリストだけでは解決できない。
 * 位置ごとに両方の可能性を展開して候補を生成する。
 */
const CONFUSION_PAIRS: Record<string, string[]> = {
  S: ["S", "5", "9"],  // S ↔ 5（最頻出）, S ↔ 9
  "5": ["5", "S"],
  "9": ["9", "S", "G"],
  B: ["B", "8"],
  "8": ["8", "B"],
  E: ["E", "F"],
  F: ["F", "E"],
  G: ["G", "9", "6"],
  "6": ["6", "G"],
};

/** 画像拡大倍率。Tesseract は文字が大きいほど精度が上がる */
const UPSCALE_FACTOR = 3;

type SerialItem = {
  id: string;
  code: string;
  createdAt: string;
  copiedAt?: string;
};

type OcrStatus = "idle" | "starting" | "ready" | "reading" | "error";

type CropSettings = {
  x: number;
  y: number;
  width: number;
  height: number;
  threshold: number;
};

const DEFAULT_CROP_SETTINGS: CropSettings = {
  x: 0.200,
  y: 0.500,
  width: 0.650,
  height: 0.085,
  threshold: 120,
};

// ─── OCR テキスト処理 ────────────────────────────────────────

/**
 * OCR 生テキストの前処理。
 * 無効文字（0,1,2,I,O）を形状が近い有効文字に確定変換する。
 */
function normalizeText(text: string): string {
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
 * 例: "SFXVPX3P3K6SV" の S を S/5/9 に、6 を 6/G に展開。
 * 候補数爆発を防ぐため最大 64 個に制限。
 */
function expandAmbiguous(code: string): string[] {
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

function scoreCandidate(code: string): number {
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
function extractSerialCandidates(text: string): string[] {
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

// ─── ユーティリティ ──────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// ─── メインコンポーネント ────────────────────────────────────

export default function SerialReaderPrototype() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoScanTimerRef = useRef<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ocrWorkerRef = useRef<any>(null);

  const [status, setStatus] = useState<OcrStatus>("idle");
  const [statusText, setStatusText] = useState("未起動");
  const [rawText, setRawText] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const [items, setItems] = useState<SerialItem[]>([]);
  const [copiedMessage, setCopiedMessage] = useState("");
  const [lastSnapshot, setLastSnapshot] = useState<string>("");
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [autoScanIntervalMs, setAutoScanIntervalMs] = useState(1200);
  const [isAutoScanning, setIsAutoScanning] = useState(false);
  const [lastAutoSavedCode, setLastAutoSavedCode] = useState("");
  const [showAdjuster, setShowAdjuster] = useState(true);
  const [cropSettings, setCropSettings] = useState<CropSettings>(DEFAULT_CROP_SETTINGS);
  const [targetUrl, setTargetUrl] = useState(
    "https://ticket.fortunemeets.app/sakurazaka46/14th#/"
  );

  const [showBookmarkletGuide, setShowBookmarkletGuide] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as SerialItem[];
        setItems(parsed);
      } catch {
        // ignore
      }
    }

    const savedCrop = localStorage.getItem(CROP_SETTINGS_KEY);
    if (savedCrop) {
      try {
        const parsed = JSON.parse(savedCrop) as CropSettings;
        setCropSettings({
          x: clamp(parsed.x ?? DEFAULT_CROP_SETTINGS.x, 0, 1),
          y: clamp(parsed.y ?? DEFAULT_CROP_SETTINGS.y, 0, 1),
          width: clamp(parsed.width ?? DEFAULT_CROP_SETTINGS.width, 0.05, 1),
          height: clamp(parsed.height ?? DEFAULT_CROP_SETTINGS.height, 0.03, 1),
          threshold: clamp(parsed.threshold ?? DEFAULT_CROP_SETTINGS.threshold, 0, 255),
        });
      } catch {
        // ignore
      }
    }

    return () => {
      stopCamera();
      stopAutoScan();
      if (ocrWorkerRef.current) {
        ocrWorkerRef.current.terminate();
        ocrWorkerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  useEffect(() => {
    localStorage.setItem(CROP_SETTINGS_KEY, JSON.stringify(cropSettings));
  }, [cropSettings]);

  useEffect(() => {
    if (!copiedMessage) return;
    const id = window.setTimeout(() => setCopiedMessage(""), 1800);
    return () => window.clearTimeout(id);
  }, [copiedMessage]);

  const duplicateSet = useMemo(() => {
    const count = new Map<string, number>();
    for (const item of items) {
      count.set(item.code, (count.get(item.code) ?? 0) + 1);
    }
    return new Set([...count.entries()].filter(([, v]) => v > 1).map(([k]) => k));
  }, [items]);

  const guideStyle = useMemo(() => {
    const left = cropSettings.x * 100;
    const top = cropSettings.y * 100;
    const width = cropSettings.width * 100;
    const heightPercent = cropSettings.height * 100;

    return {
      left: `${left}%`,
      top: `${top}%`,
      width: `${width}%`,
      height: `${heightPercent}%`,
    };
  }, [cropSettings]);

  function stopAutoScan() {
    if (autoScanTimerRef.current !== null) {
      window.clearTimeout(autoScanTimerRef.current);
      autoScanTimerRef.current = null;
    }
    setIsAutoScanning(false);
  }

  async function startCamera() {
    try {
      setStatus("starting");
      setStatusText("カメラ起動中...");

      stopCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("video element not found");

      video.srcObject = stream;
      await video.play();

      setStatus("ready");
      setStatusText("カメラ準備OK");
    } catch (error) {
      console.error(error);
      setStatus("error");
      setStatusText("カメラ起動失敗。HTTPS とカメラ権限を確認してください。");
    }
  }

  function stopCamera() {
    stopAutoScan();
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }

  /**
   * ガイド枠の映像を切り出し、前処理して PNG 化する。
   * 3倍に拡大 → コントラスト強調 → 二値化。
   */
  function captureGuideArea(thresholdOverride?: number): string | null {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;
    if (!video.videoWidth || !video.videoHeight) return null;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const cropWidth = Math.floor(vw * cropSettings.width);
    const cropHeight = Math.floor(vh * cropSettings.height);
    const cropX = Math.floor(vw * cropSettings.x);
    const cropY = Math.floor(vh * cropSettings.y);

    const outW = cropWidth * UPSCALE_FACTOR;
    const outH = cropHeight * UPSCALE_FACTOR;

    canvas.width = outW;
    canvas.height = outH;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, outW, outH);

    const threshold = thresholdOverride ?? cropSettings.threshold;

    const imageData = ctx.getImageData(0, 0, outW, outH);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      // コントラスト強調
      const adjusted = ((gray / 255 - 0.5) * 1.5 + 0.5) * 255;
      const clamped = Math.max(0, Math.min(255, adjusted));
      const bw = clamped > threshold ? 255 : 0;
      data[i] = bw;
      data[i + 1] = bw;
      data[i + 2] = bw;
    }
    ctx.putImageData(imageData, 0, 0);

    return canvas.toDataURL("image/png");
  }

  function saveCode(code: string, options?: { silent?: boolean; isAuto?: boolean }) {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return false;

    let didSave = false;

    setItems((prev) => {
      if (prev[0]?.code === trimmed) {
        if (!options?.silent) {
          setStatusText(`同一コードを連続保存しないようスキップ: ${trimmed}`);
        }
        return prev;
      }

      didSave = true;
      return [
        {
          id: crypto.randomUUID(),
          code: trimmed,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ];
    });

    if (didSave && options?.isAuto) {
      setLastAutoSavedCode(trimmed);
    }

    return didSave;
  }

  /**
   * OCR 実行。しきい値を変えた2パスで実行し結果をマージ。
   */
  async function readSerial(options?: { autoSave?: boolean }) {
    try {
      setStatus("reading");
      setStatusText(options?.autoSave ? "連続スキャン実行中..." : "OCR実行中...");
      setRawText("");
      setCandidates([]);
      setSelectedCandidate("");

      const Tesseract = await import("tesseract.js");
      if (!ocrWorkerRef.current) {
        const worker = await Tesseract.createWorker("eng", undefined, {
          logger: (m: { status: string; progress?: number }) => {
            if (m.status === "recognizing text") {
              setStatusText(
                `OCR実行中... ${Math.round((m.progress ?? 0) * 100)}%`
              );
            }
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (worker as any).setParameters({
          tessedit_pageseg_mode: "7",
          tessedit_char_whitelist: "3456789ABCDEFGHJKLMNPQRSTUVWXYZ",
        });
        ocrWorkerRef.current = worker;
      }

      // パス1: 通常しきい値
      const snapshot1 = captureGuideArea();
      if (!snapshot1) throw new Error("capture failed");
      setLastSnapshot(snapshot1);
      const result1 = await ocrWorkerRef.current.recognize(snapshot1);
      const text1 = result1.data.text ?? "";

      // パス2: しきい値 +25 でもう一度
      const snapshot2 = captureGuideArea(cropSettings.threshold + 25);
      const result2 = snapshot2
        ? await ocrWorkerRef.current.recognize(snapshot2)
        : null;
      const text2 = result2?.data?.text ?? "";

      const combinedText = text1 + " " + text2;
      setRawText(text1 + (text2 ? ` | ${text2}` : ""));

      const found = extractSerialCandidates(combinedText);
      setCandidates(found);
      setSelectedCandidate(found[0] ?? "");

      if (options?.autoSave && found[0]) {
        const saved = saveCode(found[0], { silent: true, isAuto: true });
        setStatusText(saved ? `自動保存: ${found[0]}` : `同一コードをスキップ: ${found[0]}`);
      } else {
        setStatusText(
          found.length > 0
            ? `候補 ${found.length} 件（末尾${CURRENT_SINGLE_SUFFIX}優先）`
            : "候補なし。位置を合わせ直してください。"
        );
      }

      setStatus("ready");
      return found;
    } catch (error) {
      console.error(error);
      setStatus("error");
      setStatusText("OCRに失敗しました");
      return [] as string[];
    }
  }

  async function runAutoScanLoop() {
    if (!autoScanEnabled || autoScanTimerRef.current !== null || status !== "ready") return;
    setIsAutoScanning(true);

    const loop = async () => {
      autoScanTimerRef.current = null;
      if (!autoScanEnabled || !streamRef.current) {
        setIsAutoScanning(false);
        return;
      }

      const found = await readSerial({ autoSave: true });
      const delay = found.length > 0 ? autoScanIntervalMs : Math.max(autoScanIntervalMs, 1600);

      if (!autoScanEnabled || !streamRef.current) {
        setIsAutoScanning(false);
        return;
      }

      autoScanTimerRef.current = window.setTimeout(loop, delay);
    };

    autoScanTimerRef.current = window.setTimeout(loop, autoScanIntervalMs);
  }

  useEffect(() => {
    if (autoScanEnabled && status === "ready" && streamRef.current) {
      runAutoScanLoop();
    }
    if (!autoScanEnabled) {
      stopAutoScan();
    }

    return () => {
      if (!autoScanEnabled) stopAutoScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScanEnabled, autoScanIntervalMs, status]);

  function addSelected() {
    if (!selectedCandidate) return;
    const saved = saveCode(selectedCandidate);
    if (saved) {
      setStatusText(`保存しました: ${selectedCandidate.toUpperCase()}`);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setItems((prev) =>
        prev.map((item) =>
          item.code === code && !item.copiedAt
            ? { ...item, copiedAt: new Date().toISOString() }
            : item
        )
      );
      setCopiedMessage(`${code} をコピーしました`);
    } catch (error) {
      console.error(error);
      setCopiedMessage("コピーに失敗しました");
    }
  }

  async function copyAll() {
  const text = items.map((item) => item.code).join("\n\n");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setCopiedMessage("全件コピーしました");
  } catch (error) {
    console.error(error);
    setCopiedMessage("一括コピーに失敗しました");
  }
}

  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function clearAll() {
    if (!window.confirm("保存済みコードを全削除しますか？")) return;
    setItems([]);
    setLastAutoSavedCode("");
  }

  function resetCropSettings() {
    setCropSettings(DEFAULT_CROP_SETTINGS);
  }

const BOOKMARKLET_CODE = [
  'javascript:void(async function(){',
  'try{',
  'var text;',
  'try{text=await navigator.clipboard.readText()}',
  'catch(e){text=window.prompt("シリアルを貼り付けてください（改行区切り）")}',
  'if(!text){alert("入力がありません");return}',
  'var serials=text.split(/[\\n\\s,;]+/).map(function(s){return s.trim()}).filter(function(s){return /^[A-Z0-9]{13}$/.test(s)}).slice(0,10);',
  'if(serials.length===0){alert("有効なシリアルが見つかりませんでした");return}',
  'var inputs=Array.from(document.querySelectorAll(\'input[type="text"],input:not([type])\')).filter(function(el){var st=getComputedStyle(el);return st.display!=="none"&&st.visibility!=="hidden"&&el.offsetParent!==null});',
  'if(inputs.length===0){alert("入力欄が見つかりませんでした");return}',
  'var f=0;',
  'for(var i=0;i<serials.length&&i<inputs.length;i++){',
  'var inp=inputs[i];',
  'Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(inp,serials[i]);',
  'inp.dispatchEvent(new Event("input",{bubbles:true}));',
  'inp.dispatchEvent(new Event("change",{bubbles:true}));',
  'f++}',
  'alert(f+"件入力しました")',
  '}catch(e){alert("失敗しました: "+e.message)}',
  '}())',
].join('');
  
  return (
    <div className="app-shell">
      <div className="app-container">
        <div className="panel">
          <h1 className="title">シリアル読み取り試作版</h1>
          <p className="description">
            カメラ映像のガイド枠を実物のコード文字列に合わせて読み取ります。
          </p>

          <div className="button-row">
            <button onClick={startCamera} className="btn btn-primary">
              カメラ起動
            </button>
            <button onClick={() => readSerial()} disabled={status !== "ready"} className="btn btn-read">
              読み取る
            </button>
            <button onClick={stopCamera} className="btn btn-secondary">
              カメラ停止
            </button>
            <button onClick={() => setShowAdjuster((v) => !v)} className="btn btn-secondary">
              {showAdjuster ? "調整を隠す" : "調整を表示"}
            </button>
          </div>

          <div className="control-grid">
            <label className="control-box">
              <input
                type="checkbox"
                checked={autoScanEnabled}
                onChange={(e) => setAutoScanEnabled(e.target.checked)}
              />
              <span>連続スキャン</span>
            </label>

            <label className="control-box">
              <span>間隔(ms)</span>
              <input
                type="number"
                min={800}
                max={5000}
                step={100}
                value={autoScanIntervalMs}
                onChange={(e) => setAutoScanIntervalMs(Number(e.target.value) || 1200)}
                className="number-input"
              />
            </label>

            <div className="control-box">連続状態: {isAutoScanning ? "実行中" : "停止中"}</div>
          </div>

          <div className="control-box">
            <span>遷移URL</span>
            <input
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              className="text-input"
            />
          </div>

          {showAdjuster && (
            <div className="adjuster-panel">
              <div className="adjuster-header">
                <strong>切り抜き調整</strong>
                <button onClick={resetCropSettings} className="btn btn-small btn-secondary" type="button">
                  初期値に戻す
                </button>
              </div>

              <div className="adjuster-grid">
                <label className="slider-row">
                  <span>X: {cropSettings.x.toFixed(3)}</span>
                  <input
                    type="range"
                    min="0"
                    max="0.8"
                    step="0.005"
                    value={cropSettings.x}
                    onChange={(e) =>
                      setCropSettings((prev) => ({
                        ...prev,
                        x: Number(e.target.value),
                      }))
                    }
                  />
                </label>

                <label className="slider-row">
                  <span>Y: {cropSettings.y.toFixed(3)}</span>
                  <input
                    type="range"
                    min="0"
                    max="0.95"
                    step="0.005"
                    value={cropSettings.y}
                    onChange={(e) =>
                      setCropSettings((prev) => ({
                        ...prev,
                        y: Number(e.target.value),
                      }))
                    }
                  />
                </label>

                <label className="slider-row">
                  <span>幅: {cropSettings.width.toFixed(3)}</span>
                  <input
                    type="range"
                    min="0.1"
                    max="0.9"
                    step="0.005"
                    value={cropSettings.width}
                    onChange={(e) =>
                      setCropSettings((prev) => ({
                        ...prev,
                        width: Number(e.target.value),
                      }))
                    }
                  />
                </label>

                <label className="slider-row">
                  <span>高さ: {cropSettings.height.toFixed(3)}</span>
                  <input
                    type="range"
                    min="0.03"
                    max="0.25"
                    step="0.005"
                    value={cropSettings.height}
                    onChange={(e) =>
                      setCropSettings((prev) => ({
                        ...prev,
                        height: Number(e.target.value),
                      }))
                    }
                  />
                </label>

                <label className="slider-row">
                  <span>しきい値: {cropSettings.threshold}</span>
                  <input
                    type="range"
                    min="80"
                    max="240"
                    step="1"
                    value={cropSettings.threshold}
                    onChange={(e) =>
                      setCropSettings((prev) => ({
                        ...prev,
                        threshold: Number(e.target.value),
                      }))
                    }
                  />
                </label>
              </div>
            </div>
          )}

          <div className="status-box">状態: {statusText}</div>

          {lastAutoSavedCode && (
            <div className="auto-save-box">
              直近の自動保存: <span className="mono">{lastAutoSavedCode}</span>
            </div>
          )}
        </div>

        <div className="main-grid">
          <div className="panel">
            <div className="camera-frame">
              <video ref={videoRef} playsInline muted autoPlay className="camera-video" />

              <div className="camera-overlay">
                <div className="camera-dim" />
                <div className="guide-box-manual" style={guideStyle} />
                <div className="guide-label-manual">この枠にコード文字列を合わせる</div>
              </div>
            </div>

            <canvas ref={canvasRef} className="hidden-canvas" />

            <div className="preview-grid">
              <div>
                <h2 className="section-title">OCR生テキスト</h2>
                <div className="preview-box">{rawText || "まだ読み取り結果はありません"}</div>
              </div>

              <div>
                <h2 className="section-title">切り出し画像</h2>
                <div className="preview-box image-box">
                  {lastSnapshot ? (
                    <img src={lastSnapshot} alt="snapshot" className="snapshot-image" />
                  ) : (
                    <span className="muted">まだ画像はありません</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="side-column">
            <div className="panel">
              <h2 className="section-heading">候補</h2>
              <div className="candidate-list">
                {candidates.length === 0 ? (
                  <div className="empty-box">読み取り候補はまだありません</div>
                ) : (
                  candidates.map((candidate) => (
                    <label key={candidate} className="candidate-item">
                      <input
                        type="radio"
                        name="candidate"
                        checked={selectedCandidate === candidate}
                        onChange={() => setSelectedCandidate(candidate)}
                      />
                      <span className="mono candidate-text">{candidate}</span>
                    </label>
                  ))
                )}
              </div>

              <div className="manual-edit">
                <div className="manual-label">手動修正</div>
                <input
                  type="text"
                  value={selectedCandidate}
                  onChange={(e) => setSelectedCandidate(e.target.value.toUpperCase())}
                  maxLength={13}
                  className="text-input mono"
                  placeholder="ここで修正できます"
                />
              </div>

              <button
                onClick={addSelected}
                disabled={!selectedCandidate}
                className="btn btn-save full-width"
              >
                保存
              </button>
            </div>

<div className="panel" style={{ marginTop: 16 }}>
  <h2 className="section-heading">ブックマークレット</h2>
  <p style={{ fontSize: 13, color: "#475569", lineHeight: 1.6, margin: "8px 0 16px" }}>
    応募ページで使うツールです。シリアルを最大10件まとめて入力欄に自動入力できます。
  </p>

  <div style={{ background: "#f8fafc", borderRadius: 16, padding: 16, textAlign: "center" }}>
    <a href={BOOKMARKLET_CODE}
      onClick={(e) => e.preventDefault()}
      style={{
        display: "inline-block",
        background: "#7c3aed",
        color: "#fff",
        fontWeight: 700,
        fontSize: 15,
        padding: "12px 24px",
        borderRadius: 16,
        textDecoration: "none",
        cursor: "grab",
      }}
    >
      シリアル一括入力
    </a>
    <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
      PCの方：このボタンをブックマークバーにドラッグ
    </div>
  </div>

  <button
    className="btn btn-small btn-secondary full-width"
    style={{ marginTop: 12 }}
    onClick={() => {
      navigator.clipboard.writeText(BOOKMARKLET_CODE).then(() => {
        alert("ブックマークレットをコピーしました。\nブラウザのブックマークに新規追加し、URL欄に貼り付けてください。");
      }).catch(() => {
        window.prompt("以下をコピーしてブックマークのURLに貼り付けてください:", BOOKMARKLET_CODE);
      });
    }}
  >
    コードをコピー（スマホ用）
  </button>

  <button
    className="btn btn-small btn-secondary full-width"
    style={{ marginTop: 8 }}
    onClick={() => setShowBookmarkletGuide((v) => !v)}
  >
    {showBookmarkletGuide ? "▲ 登録手順を閉じる" : "▼ 登録手順を見る（初回のみ）"}
  </button>

  {showBookmarkletGuide && (
    <div style={{ marginTop: 12, fontSize: 13, color: "#334155", lineHeight: 1.8 }}>

      <div style={{ background: "#eff6ff", borderRadius: 12, padding: 14, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, color: "#1d4ed8" }}>
          {"📱 iPhone（Safari）の場合"}
        </div>
        <div>{"1. 上の「コードをコピー」ボタンを押す"}</div>
        <div>{"2. まず適当なページをブックマーク登録する"}</div>
        <div>{"3. ブックマーク一覧を開き、今登録したブックマークを「編集」"}</div>
        <div>{"4. 名前を「シリアル一括入力」に変更"}</div>
        <div>{"5. URL欄を全選択して削除し、コピーしたコードを貼り付け"}</div>
        <div>{"6. 「完了」で保存"}</div>
      </div>

      <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 14, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, color: "#15803d" }}>
          {"📱 Android（Chrome）の場合"}
        </div>
        <div>{"1. 上の「コードをコピー」ボタンを押す"}</div>
        <div>{"2. まず適当なページをブックマーク登録する"}</div>
        <div>{"3. 右上 ︙ →「ブックマーク」→ 今登録したブックマークを長押し →「編集」"}</div>
        <div>{"4. 名前を「シリアル一括入力」に変更"}</div>
        <div>{"5. URL欄を全選択して削除し、コピーしたコードを貼り付け"}</div>
        <div>{"6. 「保存」で完了"}</div>
      </div>

      <div style={{ background: "#faf5ff", borderRadius: 12, padding: 14, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, color: "#7c3aed" }}>
          {"💻 PC（Chrome / Edge）の場合"}
        </div>
        <div>{"上の紫色のボタンをブックマークバーに直接ドラッグ＆ドロップするだけでOK"}</div>
        <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
          {"※ ブックマークバーが非表示の場合は Ctrl+Shift+B で表示"}
        </div>
      </div>

      <div style={{ background: "#fefce8", borderRadius: 12, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, color: "#a16207" }}>
          {"🔄 使い方（毎回の手順）"}
        </div>
        <div>{"1. このアプリでシリアルを読み取り・保存する"}</div>
        <div>{"2.「全件コピー」ボタンを押す"}</div>
        <div>{"3.「応募ページを開く」で応募サイトへ移動"}</div>
        <div>{"4. 登録したブックマーク「シリアル一括入力」をタップ"}</div>
        <div>{"5. 入力欄に自動入力される"}</div>
      </div>

    </div>
  )}
</div>
            <div className="panel">
              <div className="panel-header">
                <h2 className="section-heading">保存済みコード</h2>
                <button
                onClick={() => window.open(targetUrl, "_blank")}
                disabled={items.length === 0}
                className="btn btn-primary full-width"
              　>
                応募ページを開く
              </button>
                <div className="small-button-row">
                  <button onClick={copyAll} className="btn btn-small btn-secondary">
                    全件コピー
                  </button>
                  <button onClick={clearAll} className="btn btn-small btn-danger">
                    全削除
                  </button>
                </div>
              </div>

              {copiedMessage && <div className="copied-box">{copiedMessage}</div>}

              <div className="saved-list">
                {items.length === 0 ? (
                  <div className="empty-box">まだ保存されていません</div>
                ) : (
                  items.map((item) => (
                    <div key={item.id} className="saved-item">
                      <div className="saved-left">
                        <div className="mono saved-code">{item.code}</div>
                        <div className="saved-date">登録: {formatDate(item.createdAt)}</div>
                        {duplicateSet.has(item.code) && <div className="duplicate-text">重複あり</div>}
                      </div>

                      <div className="saved-actions">
                        <button onClick={() => copyCode(item.code)} className="btn btn-small btn-primary">
                          コピー
                        </button>
                        <button onClick={() => removeItem(item.id)} className="btn btn-small btn-secondary">
                          削除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bottom-shutter-wrap">
        <button
          onClick={() => readSerial()}
          disabled={status !== "ready"}
          aria-label="読み取る"
          className="bottom-shutter"
        >
          <div className="bottom-shutter-inner" />
        </button>
      </div>
    </div>
  );
}
