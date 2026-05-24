import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";

import type { CropSettings } from "./types";
import {
  CROP_SETTINGS_KEY,
  DEFAULT_CROP_SETTINGS,
  CURRENT_SINGLE_SUFFIX,
  UPSCALE_FACTOR,
} from "./constants";
import { clamp } from "./utils/helpers";
import { extractSerialCandidates } from "./utils/ocr";

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

  function captureGuideArea(thresholdOverride?: number): string | null {
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

    const threshold = thresholdOverride ?? cropSettings.threshold;

    const imageData = ctx.getImageData(0, 0, outW, outH);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray =
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
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

  async function readSerial(
    options?: { autoSave?: boolean }
  ): Promise<string[]> {
    try {
      camera.setStatus("reading");
      camera.setStatusText(
        options?.autoSave ? "連続スキャン実行中..." : "OCR実行中..."
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
