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
import { extractRawSerials, aggregateCandidates } from "./utils/ocr";

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
    const threshold = cropSettings.threshold + thresholdOffset;

    const imageData = ctx.getImageData(0, 0, outW, outH);
    const data = imageData.data;

    // Step 1: グレースケール＋コントラスト強調
    const gray = new Uint8ClampedArray(outW * outH);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const adjusted = ((g / 255 - 0.5) * 1.5 + 0.5) * 255;
      gray[p] = Math.max(0, Math.min(255, adjusted));
    }

    // Step 2: シャープニング（5点ラプラシアン）。薄い線を強調して誤認の票割れを促す
    let processed = gray;
    if (passCfg?.sharpen) {
      const sharpened = new Uint8ClampedArray(outW * outH);
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          const idx = y * outW + x;
          if (x === 0 || x === outW - 1 || y === 0 || y === outH - 1) {
            sharpened[idx] = gray[idx];
            continue;
          }
          const c = gray[idx];
          const t = gray[idx - outW];
          const b = gray[idx + outW];
          const l = gray[idx - 1];
          const r = gray[idx + 1];
          const v = 5 * c - t - b - l - r;
          sharpened[idx] = Math.max(0, Math.min(255, v));
        }
      }
      processed = sharpened;
    }

    // Step 3: 二値化
    const binary = new Uint8ClampedArray(outW * outH);
    for (let p = 0; p < processed.length; p++) {
      binary[p] = processed[p] > threshold ? 255 : 0;
    }

    // Step 4: モルフォロジー演算
    //   thicken: 黒（文字）を膨張 → ノイズで途切れた線を補完
    //   thin:    黒を収縮 → 太すぎて潰れた文字を細く
    let finalBuf = binary;
    if (passCfg?.morphology) {
      const morphed = new Uint8ClampedArray(outW * outH);
      const isThicken = passCfg.morphology === "thicken";
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          const idx = y * outW + x;
          if (x === 0 || x === outW - 1 || y === 0 || y === outH - 1) {
            morphed[idx] = binary[idx];
            continue;
          }
          let hasBlack = false;
          let hasWhite = false;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const v = binary[(y + dy) * outW + (x + dx)];
              if (v === 0) hasBlack = true;
              else hasWhite = true;
            }
          }
          if (isThicken) {
            morphed[idx] = hasBlack ? 0 : 255;
          } else {
            morphed[idx] = hasWhite ? 255 : 0;
          }
        }
      }
      finalBuf = morphed;
    }

    // RGBA に書き戻し
    for (let p = 0, i = 0; p < finalBuf.length; p++, i += 4) {
      const v = finalBuf[p];
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
          : `OCR実行中... (高精度 ${passes.length}パス)`
      );
      setRawText("");
      setCandidates([]);
      setSelectedCandidate("");

      const Tesseract = await import("tesseract.js");
      if (!ocrWorkerRef.current) {
        const worker = await Tesseract.createWorker("eng", undefined, {
          logger: (m: { status: string; progress?: number }) => {
            if (m.status === "recognizing text") {
              camera.setStatusText(
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

      const allRawCandidates: string[] = [];
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

        const result = await ocrWorkerRef.current.recognize(snapshot);
        const text: string = result.data.text ?? "";
        rawTexts.push(text.trim());

        // 各パスから 13 桁の生候補を抽出
        allRawCandidates.push(...extractRawSerials(text));
      }

      if (firstSnapshot) setLastSnapshot(firstSnapshot);
      setRawText(rawTexts.filter(Boolean).join(" | ") || "(取得失敗)");

      // 全パスの生候補を位置投票＋スコアリングで集約
      const found = aggregateCandidates(allRawCandidates);
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
        // 何パスで同じ生候補が出たかを表示して信頼度を伝える
        const occurrence = new Map<string, number>();
        for (const c of allRawCandidates) {
          occurrence.set(c, (occurrence.get(c) ?? 0) + 1);
        }
        const topOccurrence = occurrence.get(found[0] ?? "") ?? 0;
        const matchHint =
          topOccurrence >= 2
            ? `・${topOccurrence}/${passes.length}パス一致`
            : "";

        camera.setStatusText(
          found.length > 0
            ? `候補 ${found.length} 件（末尾${CURRENT_SINGLE_SUFFIX}優先${matchHint}）`
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
