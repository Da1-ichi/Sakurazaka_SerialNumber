import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";

import type { CropSettings } from "./types";
import {
  CROP_SETTINGS_KEY,
  DEFAULT_CROP_SETTINGS,
  CURRENT_SINGLE_SUFFIX,
  UPSCALE_FACTOR,
  QUICK_PASSES,
  ACCURATE_PASSES,
} from "./constants";
import type { PassConfig } from "./constants";
import { clamp } from "./utils/helpers";
import {
  extractRawSerials,
  aggregateCandidates,
  aggregateBySymbols,
} from "./utils/ocr";
import type { OcrSymbol } from "./utils/ocr";

import { useCamera } from "./hooks/useCamera";
import { useSerialItems } from "./hooks/useSerialItems";

import { ScanControls } from "./components/ScanControls";
import { CropAdjuster } from "./components/CropAdjuster";
import { CameraPanel } from "./components/CameraPanel";
import { CandidatePanel } from "./components/CandidatePanel";
import { BookmarkletPanel } from "./components/BookmarkletPanel";
import { SavedItemList } from "./components/SavedItemList";

// ─── メインコンポーネント ────────────────────────────────────

export default function SerialReaderPrototype() {
  const camera = useCamera();
  const serialItems = useSerialItems();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ocrWorkerRef = useRef<any>(null);
  const autoScanTimerRef = useRef<number | null>(null);

  const [rawText, setRawText] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const [lastSnapshot, setLastSnapshot] = useState("");
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [autoScanIntervalMs, setAutoScanIntervalMs] = useState(1200);
  const [isAutoScanning, setIsAutoScanning] = useState(false);
  const [showAdjuster, setShowAdjuster] = useState(true);
  const [cropSettings, setCropSettings] = useState<CropSettings>(
    DEFAULT_CROP_SETTINGS
  );
  const [targetUrl, setTargetUrl] = useState(
    "https://ticket.fortunemeets.app/sakurazaka46/14th#/"
  );

  // ─── cropSettings の永続化 ─────────────────────────────────

  useEffect(() => {
    const savedCrop = localStorage.getItem(CROP_SETTINGS_KEY);
    if (savedCrop) {
      try {
        const parsed = JSON.parse(savedCrop) as CropSettings;
        setCropSettings({
          x: clamp(parsed.x ?? DEFAULT_CROP_SETTINGS.x, 0, 1),
          y: clamp(parsed.y ?? DEFAULT_CROP_SETTINGS.y, 0, 1),
          width: clamp(parsed.width ?? DEFAULT_CROP_SETTINGS.width, 0.05, 1),
          height: clamp(
            parsed.height ?? DEFAULT_CROP_SETTINGS.height,
            0.03,
            1
          ),
          threshold: clamp(
            parsed.threshold ?? DEFAULT_CROP_SETTINGS.threshold,
            0,
            255
          ),
        });
      } catch {
        // ignore
      }
    }

    return () => {
      stopAutoScan();
      if (ocrWorkerRef.current) {
        ocrWorkerRef.current.terminate();
        ocrWorkerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(CROP_SETTINGS_KEY, JSON.stringify(cropSettings));
  }, [cropSettings]);

  // ─── ガイド枠スタイル ──────────────────────────────────────

  const guideStyle = useMemo(() => {
    return {
      left: `${cropSettings.x * 100}%`,
      top: `${cropSettings.y * 100}%`,
      width: `${cropSettings.width * 100}%`,
      height: `${cropSettings.height * 100}%`,
    };
  }, [cropSettings]);

  // ─── 自動スキャン ──────────────────────────────────────────

  function stopAutoScan() {
    if (autoScanTimerRef.current !== null) {
      window.clearTimeout(autoScanTimerRef.current);
      autoScanTimerRef.current = null;
    }
    setIsAutoScanning(false);
  }

  async function runAutoScanLoop() {
    if (
      !autoScanEnabled ||
      autoScanTimerRef.current !== null ||
      camera.status !== "ready"
    )
      return;
    setIsAutoScanning(true);

    const loop = async () => {
      autoScanTimerRef.current = null;
      if (!autoScanEnabled || !camera.streamRef.current) {
        setIsAutoScanning(false);
        return;
      }

      const found = await readSerial({ autoSave: true });
      const delay =
        found.length > 0
          ? autoScanIntervalMs
          : Math.max(autoScanIntervalMs, 1600);

      if (!autoScanEnabled || !camera.streamRef.current) {
        setIsAutoScanning(false);
        return;
      }

      autoScanTimerRef.current = window.setTimeout(loop, delay);
    };

    autoScanTimerRef.current = window.setTimeout(loop, autoScanIntervalMs);
  }

  useEffect(() => {
    if (
      autoScanEnabled &&
      camera.status === "ready" &&
      camera.streamRef.current
    ) {
      runAutoScanLoop();
    }
    if (!autoScanEnabled) {
      stopAutoScan();
    }

    return () => {
      if (!autoScanEnabled) stopAutoScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScanEnabled, autoScanIntervalMs, camera.status]);

  // ─── キャプチャ & OCR ──────────────────────────────────────

  function captureGuideArea(passCfg?: PassConfig): string | null {
    const video = camera.videoRef.current;
    const canvas = camera.canvasRef.current;
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

    const thresholdOffset = passCfg?.thresholdOffset ?? 0;

    const imageData = ctx.getImageData(0, 0, outW, outH);
    const data = imageData.data;

    // Step 1: グレースケール＋コントラスト強調
    const gray = new Uint8ClampedArray(outW * outH);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const adjusted = ((g / 255 - 0.5) * 1.5 + 0.5) * 255;
      gray[p] = Math.max(0, Math.min(255, adjusted));
    }

    // Step 2: Otsu 法で画像ごとに最適しきい値を自動算出
    //   固定しきい値は照明変化に弱いため、ヒストグラムからクラス間分散が
    //   最大になる境界を求める。
    const hist = new Array(256).fill(0);
    for (let p = 0; p < gray.length; p++) hist[gray[p]]++;
    const total = gray.length;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let sumB = 0;
    let wB = 0;
    let maxBetween = -1;
    let otsu = 120;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxBetween) {
        maxBetween = between;
        otsu = t;
      }
    }

    // 最終しきい値 = Otsu自動値 + 手動バイアス(スライダー) + パスオフセット
    //   スライダーが既定の 120 なら手動バイアスは 0（純粋な自動二値化）。
    //   極端な照明時のみスライダーで Otsu からずらせる。
    const manualBias = cropSettings.threshold - 120;
    const threshold = otsu + manualBias + thresholdOffset;

    // Step 3: 二値化して RGBA に書き戻し
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      const v = gray[p] > threshold ? 255 : 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);

    return canvas.toDataURL("image/png");
  }

  async function readSerial(
    options?: { autoSave?: boolean }
  ): Promise<string[]> {
    try {
      camera.setStatus("reading");
      const isAuto = options?.autoSave ?? false;
      const passes = isAuto ? QUICK_PASSES : ACCURATE_PASSES;
      camera.setStatusText(
        isAuto
          ? "連続スキャン実行中..."
          : `OCR実行中... (legacy 高精度 ${passes.length}パス)`
      );
      setRawText("");
      setCandidates([]);
      setSelectedCandidate("");

      const Tesseract = await import("tesseract.js");
      if (!ocrWorkerRef.current) {
        camera.setStatusText("認識エンジン初期化中...（初回のみ時間がかかります）");
        // legacy エンジン (OEM 0)。LSTM と違い文字単位の代替候補(choices)が
        // 取得でき、等幅シリアルの誤読も少ない。言語データは約23MBで初回ロードが重い。
        const worker = await Tesseract.createWorker("eng", 0, {
          // legacy 対応のコア／言語データを使用する
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          legacyCore: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          legacyLang: true,
          logger: (m: { status: string; progress?: number }) => {
            if (m.status === "recognizing text") {
              camera.setStatusText(
                `OCR実行中... ${Math.round((m.progress ?? 0) * 100)}%`
              );
            }
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (worker as any).setParameters({
          tessedit_pageseg_mode: "7",
          tessedit_char_whitelist: "3456789ABCDEFGHJKLMNPQRSTUVWXYZ",
        });
        ocrWorkerRef.current = worker;
      }

      const perPassSymbols: OcrSymbol[][] = [];
      const rawTexts: string[] = [];
      let firstSnapshot: string | null = null;

      for (let i = 0; i < passes.length; i++) {
        const passCfg = passes[i];
        if (!isAuto) {
          camera.setStatusText(`OCR実行中... パス ${i + 1}/${passes.length}`);
        }

        const snapshot = captureGuideArea(passCfg);
        if (!snapshot) continue;
        if (!firstSnapshot) firstSnapshot = snapshot;

        // blocks:true で文字単位(symbol)の確信度・代替候補を取得する
        const result = await ocrWorkerRef.current.recognize(
          snapshot,
          {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { blocks: true } as any
        );
        const data = result.data;
        rawTexts.push((data.text ?? "").trim());

        // symbol 列を平坦化して取り出す
        const syms: OcrSymbol[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const block of (data as any).blocks ?? []) {
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
                      .map((c: { text?: string; confidence?: number }) => ({
                        t: (c.text ?? "").toUpperCase(),
                        cf: c.confidence ?? 0,
                      }))
                      .filter((c: { t: string }) => /^[A-Z0-9]$/.test(c.t)),
                  });
                }
              }
            }
          }
        }
        perPassSymbols.push(syms);
      }

      if (firstSnapshot) setLastSnapshot(firstSnapshot);
      setRawText(rawTexts.filter(Boolean).join(" | ") || "(取得失敗)");

      // symbol 単位の確信度＋代替候補で投票集約（第二層の本体）
      let found = aggregateBySymbols(perPassSymbols);

      // 万一 symbol が取れない環境では、生テキストの文字列ベース集約に退避
      if (found.length === 0) {
        const fallback: string[] = [];
        for (const t of rawTexts) fallback.push(...extractRawSerials(t));
        found = aggregateCandidates(fallback);
      }

      setCandidates(found);
      setSelectedCandidate(found[0] ?? "");

      if (isAuto && found[0]) {
        const saved = serialItems.saveCode(found[0], {
          silent: true,
          isAuto: true,
        });
        camera.setStatusText(
          saved
            ? `自動保存: ${found[0]}`
            : `同一コードをスキップ: ${found[0]}`
        );
      } else {
        camera.setStatusText(
          found.length > 0
            ? `候補 ${found.length} 件（末尾${CURRENT_SINGLE_SUFFIX}優先）`
            : "候補なし。位置を合わせ直してください。"
        );
      }

      camera.setStatus("ready");
      return found;
    } catch (error) {
      console.error(error);
      camera.setStatus("error");
      camera.setStatusText("OCRに失敗しました");
      return [];
    }
  }

  // ─── イベントハンドラ ──────────────────────────────────────

  function handleAddSelected() {
    if (!selectedCandidate) return;
    const saved = serialItems.addSelected(selectedCandidate);
    if (saved) {
      camera.setStatusText(
        `保存しました: ${selectedCandidate.toUpperCase()}`
      );
    }
  }

  function handleStopCamera() {
    stopAutoScan();
    camera.stopCamera();
  }

  // ─── レンダリング ──────────────────────────────────────────

  return (
    <div className="app-shell">
      <div className="app-container">
        <div className="panel">
          <h1 className="title">シリアル読み取り試作版</h1>
          <p className="description">
            カメラ映像のガイド枠を実物のコード文字列に合わせて読み取ります。
          </p>

          <ScanControls
            status={camera.status}
            statusText={camera.statusText}
            autoScanEnabled={autoScanEnabled}
            autoScanIntervalMs={autoScanIntervalMs}
            isAutoScanning={isAutoScanning}
            showAdjuster={showAdjuster}
            lastAutoSavedCode={serialItems.lastAutoSavedCode}
            targetUrl={targetUrl}
            onStartCamera={camera.startCamera}
            onStopCamera={handleStopCamera}
            onReadSerial={() => readSerial()}
            onAutoScanChange={setAutoScanEnabled}
            onIntervalChange={setAutoScanIntervalMs}
            onToggleAdjuster={() => setShowAdjuster((v) => !v)}
            onTargetUrlChange={setTargetUrl}
          />

          {showAdjuster && (
            <CropAdjuster
              cropSettings={cropSettings}
              onChange={setCropSettings}
              onReset={() => setCropSettings(DEFAULT_CROP_SETTINGS)}
            />
          )}
        </div>

        <div className="main-grid">
          <CameraPanel
            videoRef={camera.videoRef}
            canvasRef={camera.canvasRef}
            guideStyle={guideStyle}
            rawText={rawText}
            lastSnapshot={lastSnapshot}
          />

          <div className="side-column">
            <CandidatePanel
              candidates={candidates}
              selectedCandidate={selectedCandidate}
              onSelect={setSelectedCandidate}
              onSave={handleAddSelected}
            />

            <BookmarkletPanel />

            <SavedItemList
              items={serialItems.items}
              duplicateSet={serialItems.duplicateSet}
              copiedMessage={serialItems.copiedMessage}
              targetUrl={targetUrl}
              onCopyCode={serialItems.copyCode}
              onCopyAll={serialItems.copyAll}
              onRemove={serialItems.removeItem}
              onClearAll={serialItems.clearAll}
            />
          </div>
        </div>
      </div>

      <div className="bottom-shutter-wrap">
        <button
          onClick={() => readSerial()}
          disabled={camera.status !== "ready"}
          aria-label="読み取る"
          className="bottom-shutter"
        >
          <div className="bottom-shutter-inner" />
        </button>
      </div>
    </div>
  );
}
