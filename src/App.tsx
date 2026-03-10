import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * シリアル読み取り試作版
 * - スマホの背面カメラを起動
 * - 画面中央の大きめガイド枠を表示
 * - 撮影したフレームからガイド枠内だけ切り出し
 * - OCR結果から英数字13桁候補を抽出
 * - 一覧保持 / コピー / 削除
 * - 手動修正
 * - 連続スキャン
 * - 同一コードの連続保存防止
 */

const SERIAL_REGEX = /[A-Z0-9]{13}/g;
const STORAGE_KEY = "serial-reader-items";

type SerialItem = {
  id: string;
  code: string;
  createdAt: string;
  copiedAt?: string;
};

type OcrStatus = "idle" | "starting" | "ready" | "reading" | "error";

function normalizeText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[Ｏ]/g, "0")
    .replace(/[ＩＬ]/g, "1")
    .replace(/[Ｂ]/g, "8")
    .replace(/[\s\-—_]/g, "")
    .replace(/[^A-Z0-9]/g, " ");
}

function extractSerialCandidates(text: string): string[] {
  const normalized = normalizeText(text);
  const set = new Set<string>();

  const direct = normalized.match(SERIAL_REGEX) ?? [];
  direct.forEach((v) => set.add(v));

  const compact = normalized.replace(/\s+/g, "");
  for (let i = 0; i <= compact.length - 13; i += 1) {
    const chunk = compact.slice(i, i + 13);
    if (/^[A-Z0-9]{13}$/.test(chunk)) {
      set.add(chunk);
    }
  }

  return [...set];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP");
}

export default function SerialReaderPrototype() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoScanTimerRef = useRef<number | null>(null);

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

    return () => {
      stopCamera();
      stopAutoScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items]);

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

    // 読み取り枠を少し大きめに
    const cropWidth = Math.floor(vw * 0.9);
    const cropHeight = Math.floor(vh * 0.25);
    const cropX = Math.floor((vw - cropWidth) / 2);
    const cropY = Math.floor(vh * 0.68);

    canvas.width = cropWidth;
    canvas.height = cropHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    // 軽い前処理
    const imageData = ctx.getImageData(0, 0, cropWidth, cropHeight);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const boosted = avg > 150 ? 255 : 0;
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

    setItems((prev) => {
      // 同一コードの連続保存防止
      if (prev[0]?.code === trimmed) {
        if (!options?.silent) {
          setStatusText(`同一コードを連続保存しないようスキップ: ${trimmed}`);
        }
        return prev;
      }

      const next: SerialItem = {
        id: crypto.randomUUID(),
        code: trimmed,
        createdAt: new Date().toISOString(),
      };

      return [next, ...prev];
    });

    if (options?.isAuto) {
      setLastAutoSavedCode(trimmed);
    }

    return true;
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
      const result = await Tesseract.recognize(snapshot, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text") {
            setStatusText(
              `${options?.autoSave ? "連続スキャン実行中" : "OCR実行中"}... ${Math.round((m.progress ?? 0) * 100)}%`
            );
          }
        },
      });

      const text = result.data.text ?? "";
      setRawText(text);

      const found = extractSerialCandidates(text);
      setCandidates(found);
      setSelectedCandidate(found[0] ?? "");

      if (options?.autoSave && found[0]) {
        saveCode(found[0], { silent: true, isAuto: true });
        setStatusText(`自動保存候補: ${found[0]}`);
      } else {
        setStatusText(found.length > 0 ? `候補 ${found.length} 件` : "候補なし。位置を合わせ直してください。");
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

  return (
    <div className="min-h-screen bg-slate-100 pb-28 text-slate-900">
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        <div className="mb-6 rounded-3xl bg-white p-5 shadow-sm">
          <h1 className="text-2xl font-bold">シリアル読み取り試作版</h1>
          <p className="mt-2 text-sm text-slate-600">
            カメラ映像の中央ガイドに「シリアルナンバー」枠を合わせて読み取ります。
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={startCamera}
              className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white"
            >
              カメラ起動
            </button>
            <button
              onClick={stopCamera}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium"
            >
              カメラ停止
            </button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <label className="flex items-center gap-2 rounded-2xl bg-slate-50 px-3 py-3 text-sm">
              <input
                type="checkbox"
                checked={autoScanEnabled}
                onChange={(e) => setAutoScanEnabled(e.target.checked)}
              />
              連続スキャン
            </label>

            <label className="flex items-center gap-2 rounded-2xl bg-slate-50 px-3 py-3 text-sm">
              間隔(ms)
              <input
                type="number"
                min={800}
                max={5000}
                step={100}
                value={autoScanIntervalMs}
                onChange={(e) => setAutoScanIntervalMs(Number(e.target.value) || 1200)}
                className="w-24 rounded-lg border border-slate-300 px-2 py-1"
              />
            </label>

            <div className="rounded-2xl bg-slate-50 px-3 py-3 text-sm text-slate-700">
              連続状態: {isAutoScanning ? "実行中" : "停止中"}
            </div>
          </div>

          <div className="mt-3 rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
            状態: {statusText}
          </div>

          {lastAutoSavedCode && (
            <div className="mt-3 rounded-2xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              直近の自動保存: <span className="font-mono">{lastAutoSavedCode}</span>
            </div>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl bg-white p-4 shadow-sm">
            <div className="relative overflow-hidden rounded-3xl bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className="aspect-[3/4] w-full object-cover"
              />

              <div className="pointer-events-none absolute inset-0">
                <div className="absolute inset-0 bg-black/25" />

                <div
                  className="absolute left-1/2 top-[68%] w-[90%] -translate-x-1/2 -translate-y-1/2 rounded-xl border-4 border-emerald-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
                  style={{ aspectRatio: "6 / 1.6" }}
                />

                <div className="absolute left-1/2 top-[57%] -translate-x-1/2 rounded-full bg-emerald-500/90 px-3 py-1 text-xs font-semibold text-white">
                  この枠にシリアル欄を合わせる
                </div>
              </div>
            </div>

            <canvas ref={canvasRef} className="hidden" />

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <h2 className="mb-2 text-sm font-semibold">OCR生テキスト</h2>
                <div className="min-h-28 whitespace-pre-wrap rounded-2xl bg-slate-50 p-3 text-sm text-slate-700">
                  {rawText || "まだ読み取り結果はありません"}
                </div>
              </div>

              <div>
                <h2 className="mb-2 text-sm font-semibold">切り出し画像</h2>
                <div className="flex min-h-28 items-center justify-center overflow-hidden rounded-2xl bg-slate-50 p-2">
                  {lastSnapshot ? (
                    <img src={lastSnapshot} alt="snapshot" className="max-h-40 rounded-lg" />
                  ) : (
                    <span className="text-sm text-slate-500">まだ画像はありません</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-3xl bg-white p-4 shadow-sm">
              <h2 className="text-lg font-semibold">候補</h2>
              <div className="mt-3 space-y-2">
                {candidates.length === 0 ? (
                  <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">
                    読み取り候補はまだありません
                  </div>
                ) : (
                  candidates.map((candidate) => (
                    <label
                      key={candidate}
                      className="flex cursor-pointer items-center gap-3 rounded-2xl border border-slate-200 p-3"
                    >
                      <input
                        type="radio"
                        name="candidate"
                        checked={selectedCandidate === candidate}
                        onChange={() => setSelectedCandidate(candidate)}
                      />
                      <span className="font-mono text-base tracking-wide">{candidate}</span>
                    </label>
                  ))
                )}
              </div>

              <div className="mt-4">
                <div className="mb-1 text-sm font-semibold">手動修正</div>
                <input
                  type="text"
                  value={selectedCandidate}
                  onChange={(e) => setSelectedCandidate(e.target.value.toUpperCase())}
                  maxLength={13}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono tracking-wide"
                  placeholder="ここで修正できます"
                />
              </div>

              <button
                onClick={addSelected}
                disabled={!selectedCandidate}
                className="mt-4 w-full rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                選択中のコードを保存
              </button>
            </div>

            <div className="rounded-3xl bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">保存済みコード</h2>
                <div className="flex gap-2">
                  <button
                    onClick={copyAll}
                    className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium"
                  >
                    全件コピー
                  </button>
                  <button
                    onClick={clearAll}
                    className="rounded-xl border border-red-300 px-3 py-2 text-xs font-medium text-red-700"
                  >
                    全削除
                  </button>
                </div>
              </div>

              {copiedMessage && (
                <div className="mt-3 rounded-2xl bg-blue-50 px-3 py-2 text-sm text-blue-700">
                  {copiedMessage}
                </div>
              )}

              <div className="mt-3 space-y-3">
                {items.length === 0 ? (
                  <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">
                    まだ保存されていません
                  </div>
                ) : (
                  items.map((item) => (
                    <div key={item.id} className="rounded-2xl border border-slate-200 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-mono text-lg tracking-wide">{item.code}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            登録: {formatDate(item.createdAt)}
                          </div>
                          {duplicateSet.has(item.code) && (
                            <div className="mt-1 text-xs font-medium text-amber-700">重複あり</div>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <button
                            onClick={() => copyCode(item.code)}
                            className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-medium text-white"
                          >
                            コピー
                          </button>
                          <button
                            onClick={() => removeItem(item.id)}
                            className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium"
                          >
                            削除
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
        <button
          onClick={() => readSerial()}
          disabled={status !== "ready"}
          aria-label="読み取る"
          className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-slate-300 bg-white shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div className="h-14 w-14 rounded-full border-2 border-slate-400 bg-slate-100" />
        </button>
      </div>
    </div>
  );
}
