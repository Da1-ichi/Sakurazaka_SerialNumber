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
 * 混同を避けるため 0/O, 1/I/L, 2/Z を排除したフォーマット。
 */
const VALID_CHARS = new Set("3456789ABCDEFGHJKLMNPQRSTUVWXYZ".split(""));

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

/**
 * OCR の誤認識を補正する。
 * 実物解析の結果、このシリアルでは 0, 1, 2, I, O が一切使われないため
 * それらを最も形状が近い有効文字に確定変換できる。
 */
function normalizeText(text: string): string {
  return text
    .toUpperCase()
    // --- 全角英数 → 半角 ---
    .replace(/[Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // --- OCR 頻出の記号誤認識 ---
    .replace(/[$(]/g, "S")
    .replace(/[!|]/g, "L")       // | → L（1 は無効文字なので L）
    .replace(/[{}[\]]/g, "")
    .replace(/[#]/g, "H")
    .replace(/[@]/g, "A")
    .replace(/[&]/g, "8")
    // --- 無効文字の確定変換（0,1,2,I,O はシリアルに存在しない） ---
    .replace(/0/g, "D")          // 0 → D（丸い形、Q も候補だが D の方が頻出）
    .replace(/1/g, "L")          // 1 → L（細い縦線）
    .replace(/2/g, "Z")          // 2 → Z（形状が近い）
    .replace(/O/g, "D")          // O → D
    .replace(/I/g, "J")          // I → J（縦線、J の方が近い）
    // --- 空白・区切り文字を除去 ---
    .replace(/[\s\-—_\.,:;'"`~]/g, "")
    // --- 英数字以外 → スペース ---
    .replace(/[^A-Z0-9]/g, " ");
}

function scoreCandidate(code: string): number {
  let score = 0;

  // 基本: 13 桁の英数字
  if (/^[A-Z0-9]{13}$/.test(code)) score += 100;

  // 末尾 "V" 一致（歴代シングル共通）
  if (code.endsWith(FIXED_SUFFIX)) score += 80;

  // 末尾 "9V" 一致（今回のシングル固有）
  if (code.endsWith(CURRENT_SINGLE_SUFFIX)) score += 100;

  // 有効文字セットのみで構成されているか（0,1,2,I,O を含まない）
  const allValid = [...code].every((ch) => VALID_CHARS.has(ch));
  if (allValid) score += 80;

  // 数字とアルファベットが混在している
  if (/\d/.test(code)) score += 10;
  if (/[A-Z]/.test(code)) score += 10;

  // 同じ文字が4連続以上は不自然
  if (!/(.)\1{3,}/.test(code)) score += 10;

  return score;
}

/**
 * OCR テキストから 13 桁のシリアル候補を抽出する。
 * 主な誤認識パターン（実測データ）に基づいてバリアントを生成し、
 * スコアリングで最も確からしい候補を上位に出す。
 *
 * 実測の主な誤認識:
 *   9 ↔ S (最頻出), 5 ↔ S, 8 ↔ B, F ↔ E, 9 ↔ G
 */
function extractSerialCandidates(text: string): string[] {
  const base = normalizeText(text);

  // 実測データに基づく誤認識バリアント
  // バリアント1: S→5 (S が 5 の誤読だった場合を補正)
  const variant_S5 = base.replace(/S/g, "5");
  // バリアント2: S→9
  const variant_S9 = base.replace(/S/g, "9");
  // バリアント3: B→8
  const variant_B8 = base.replace(/B/g, "8");
  // バリアント4: E→F
  const variant_EF = base.replace(/E/g, "F");
  // バリアント5: 末尾付近の S を 9 に（末尾 9V のため特に重要）
  const variant_tail = base.replace(/S(V\s*$|V\s)/g, "9$1");

  const variants = [base, variant_S5, variant_S9, variant_B8, variant_EF, variant_tail];

  const scored = new Map<string, number>();

  for (const normalized of variants) {
    // 正規表現で直接マッチ
    const direct = normalized.match(SERIAL_REGEX) ?? [];
    for (const value of direct) {
      const score = scoreCandidate(value);
      scored.set(value, Math.max(scored.get(value) ?? 0, score));
    }

    // 空白を詰めてスライディングウィンドウ
    const compact = normalized.replace(/\s+/g, "");
    for (let i = 0; i <= compact.length - 13; i += 1) {
      const chunk = compact.slice(i, i + 13);
      if (/^[A-Z0-9]{13}$/.test(chunk)) {
        const score = scoreCandidate(chunk);
        scored.set(chunk, Math.max(scored.get(chunk) ?? 0, score));
      }
    }
  }

  // 各候補に対して、末尾を "9V" に補正した追加候補も生成
  const extras = new Map<string, number>();
  for (const [code, _score] of scored) {
    // 末尾が SV → 9V に補正
    if (code.endsWith("SV")) {
      const fixed = code.slice(0, -2) + "9V";
      const fixedScore = scoreCandidate(fixed);
      extras.set(fixed, Math.max(extras.get(fixed) ?? 0, fixedScore));
    }
    // 末尾が GV → 9V に補正
    if (code.endsWith("GV")) {
      const fixed = code.slice(0, -2) + "9V";
      const fixedScore = scoreCandidate(fixed);
      extras.set(fixed, Math.max(extras.get(fixed) ?? 0, fixedScore));
    }
    // 末尾が 99 → 9V に補正（V→9 誤読）
    if (code.endsWith("99")) {
      const fixed = code.slice(0, -1) + "V";
      const fixedScore = scoreCandidate(fixed);
      extras.set(fixed, Math.max(extras.get(fixed) ?? 0, fixedScore));
    }
  }

  for (const [code, score] of extras) {
    scored.set(code, Math.max(scored.get(code) ?? 0, score));
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

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

  function captureGuideArea(): string | null {
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

    canvas.width = cropWidth;
    canvas.height = cropHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const imageData = ctx.getImageData(0, 0, cropWidth, cropHeight);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const boosted = avg > cropSettings.threshold ? 255 : 0;
      data[i] = boosted;
      data[i + 1] = boosted;
      data[i + 2] = boosted;
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

  async function readSerial(options?: { autoSave?: boolean }) {
    try {
      setStatus("reading");
      setStatusText(options?.autoSave ? "連続スキャン実行中..." : "OCR実行中...");
      setRawText("");
      setCandidates([]);
      setSelectedCandidate("");

      const snapshot = captureGuideArea();
      if (!snapshot) throw new Error("capture failed");
      setLastSnapshot(snapshot);

      const Tesseract = await import("tesseract.js");

      // Worker を初回だけ作成し、以降は再利用する
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
        // PSM 7 = 1行テキスト想定。ガイド枠でシリアル1行に絞っている前提
        // 文字ホワイトリストで 0,1,2,I,O を除外し誤認識を減らす
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (worker as any).setParameters({
          tessedit_pageseg_mode: "7",
          tessedit_char_whitelist: "3456789ABCDEFGHJKLMNPQRSTUVWXYZ",
        });
        ocrWorkerRef.current = worker;
      }

      const result = await ocrWorkerRef.current.recognize(snapshot);

      const text = result.data.text ?? "";
      setRawText(text);

      const found = extractSerialCandidates(text);
      setCandidates(found);
      setSelectedCandidate(found[0] ?? "");

      if (options?.autoSave && found[0]) {
        const saved = saveCode(found[0], { silent: true, isAuto: true });
        setStatusText(saved ? `自動保存: ${found[0]}` : `同一コードをスキップ: ${found[0]}`);
      } else {
        setStatusText(
          found.length > 0
            ? `候補 ${found.length} 件（末尾${FIXED_SUFFIX}優先）`
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
    const text = items.map((item) => item.code).join("\n");
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

              <button
  onClick={() => window.open(targetUrl, "_blank")}
  className="btn btn-secondary full-width"
>
  応募ページを開く
</button>
            </div>

            <div className="panel">
              <div className="panel-header">
                <h2 className="section-heading">保存済みコード</h2>
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
