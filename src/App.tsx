import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Worker } from "tesseract.js";
import "./styles.css";

import type { CropSettings } from "./types";
import {
  AUTO_SCAN_EMPTY_DELAY_MS,
  AUTO_SCAN_INTERVAL_MAX,
  AUTO_SCAN_INTERVAL_MIN,
  CROP_SETTINGS_KEY,
  DEFAULT_CROP_SETTINGS,
  DEFAULT_FORMAT_SETTINGS,
  DEFAULT_UI_SETTINGS,
  FORMAT_SETTINGS_KEY,
  UI_SETTINGS_KEY,
  UPSCALE_FACTOR,
  MAX_OCR_IMAGE_WIDTH,
  WORKER_INIT_TIMEOUT_MS,
  QUICK_PASSES,
  ACCURATE_PASSES,
  resolveValidChars,
  sanitizeSuffix,
  sanitizeValidChars,
} from "./constants";
import type { FormatSettings, PassConfig, UiSettings } from "./constants";
import { clamp } from "./utils/helpers";
import {
  extractRawSerials,
  aggregateCandidates,
  aggregateBySymbols,
  collectSymbols,
} from "./utils/ocr";
import type { OcrSymbol, SerialRules } from "./utils/ocr";

import { grayToRgba, preprocessForOcr, rgbaToGray } from "./utils/image";
import { useCamera } from "./hooks/useCamera";
import { useSerialItems } from "./hooks/useSerialItems";

import { ScanControls } from "./components/ScanControls";
import { CropAdjuster } from "./components/CropAdjuster";
import { CameraPanel } from "./components/CameraPanel";
import { CandidatePanel } from "./components/CandidatePanel";
import { BookmarkletPanel } from "./components/BookmarkletPanel";
import { SavedItemList } from "./components/SavedItemList";
import { PhotoBatchPanel } from "./components/PhotoBatchPanel";
import type { GrayImage } from "./utils/image";
import { grayToDataUrl } from "./utils/photoDecode";

// ─── 設定の読み込み・整形 ────────────────────────────────────

/** localStorage から JSON を読む。ない・壊れている場合は null */
function loadJson<T>(key: string): Partial<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Partial<T>) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても画面の動作は続ける
  }
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 枠の設定を範囲内に収める。枠が映像の外にはみ出さないよう、
 * 動かした値（prev と比べて変わった値）は保ち、相手側を詰める。
 *   - 幅・高さを広げた → 幅・高さを「1 − 位置」までに抑える
 *   - 位置を動かした   → 位置を「1 − 幅・高さ」までに抑える
 */
function normalizeCrop(next: CropSettings, prev?: CropSettings): CropSettings {
  let width = clamp(next.width, 0.05, 1);
  let height = clamp(next.height, 0.03, 1);
  let x = clamp(next.x, 0, 1);
  let y = clamp(next.y, 0, 1);

  if (prev && width !== prev.width) width = Math.min(width, 1 - x);
  else x = Math.min(x, 1 - width);
  if (prev && height !== prev.height) height = Math.min(height, 1 - y);
  else y = Math.min(y, 1 - height);

  return {
    x,
    y,
    width: Math.max(width, 0.05),
    height: Math.max(height, 0.03),
    threshold: clamp(next.threshold, 0, 255),
  };
}

function loadCropSettings(): CropSettings {
  const saved = loadJson<CropSettings>(CROP_SETTINGS_KEY);
  if (!saved) return DEFAULT_CROP_SETTINGS;
  return normalizeCrop({
    x: toNumber(saved.x, DEFAULT_CROP_SETTINGS.x),
    y: toNumber(saved.y, DEFAULT_CROP_SETTINGS.y),
    width: toNumber(saved.width, DEFAULT_CROP_SETTINGS.width),
    height: toNumber(saved.height, DEFAULT_CROP_SETTINGS.height),
    threshold: toNumber(saved.threshold, DEFAULT_CROP_SETTINGS.threshold),
  });
}

function loadFormatSettings(): FormatSettings {
  const saved = loadJson<FormatSettings>(FORMAT_SETTINGS_KEY);
  if (!saved) return DEFAULT_FORMAT_SETTINGS;
  return {
    suffix:
      typeof saved.suffix === "string"
        ? sanitizeSuffix(saved.suffix)
        : DEFAULT_FORMAT_SETTINGS.suffix,
    validChars:
      typeof saved.validChars === "string"
        ? sanitizeValidChars(saved.validChars)
        : DEFAULT_FORMAT_SETTINGS.validChars,
    targetUrl:
      typeof saved.targetUrl === "string" && saved.targetUrl.trim()
        ? saved.targetUrl
        : DEFAULT_FORMAT_SETTINGS.targetUrl,
  };
}

function clampInterval(ms: number): number {
  return clamp(
    Math.round(ms) || DEFAULT_UI_SETTINGS.autoScanIntervalMs,
    AUTO_SCAN_INTERVAL_MIN,
    AUTO_SCAN_INTERVAL_MAX
  );
}

function loadUiSettings(): UiSettings {
  const saved = loadJson<UiSettings>(UI_SETTINGS_KEY);
  if (!saved) return DEFAULT_UI_SETTINGS;
  return {
    autoScanIntervalMs: clampInterval(
      toNumber(saved.autoScanIntervalMs, DEFAULT_UI_SETTINGS.autoScanIntervalMs)
    ),
    showAdjuster:
      typeof saved.showAdjuster === "boolean"
        ? saved.showAdjuster
        : DEFAULT_UI_SETTINGS.showAdjuster,
  };
}

/**
 * 映像のうち、画面に実際に見えている範囲（映像の画素座標）を求める。
 * 映像は CSS の object-fit: cover で表示枠に合わせて上下か左右が切れるため、
 * ガイド枠（表示枠に対する割合）をそのまま映像全体の割合として使うとずれる。
 */
function visibleSourceRect(video: HTMLVideoElement) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = video.clientWidth;
  const ch = video.clientHeight;
  if (!cw || !ch) return { sx: 0, sy: 0, sw: vw, sh: vh };

  const fit = getComputedStyle(video).objectFit;
  if (fit !== "cover") return { sx: 0, sy: 0, sw: vw, sh: vh };

  const scale = Math.max(cw / vw, ch / vh);
  const sw = Math.min(vw, cw / scale);
  const sh = Math.min(vh, ch / scale);
  return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
}

// ─── メインコンポーネント ────────────────────────────────────

export default function SerialReaderPrototype() {
  const camera = useCamera();
  const serialItems = useSerialItems();

  const ocrWorkerRef = useRef<Worker | null>(null);
  /** ワーカーに現在設定してある認識文字（変わったときだけ設定し直す） */
  const appliedWhitelistRef = useRef("");
  /** 読み取りの重複実行を防ぐ（手動と自動が重ならないように） */
  const readingRef = useRef(false);

  const [rawText, setRawText] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const [lastSnapshot, setLastSnapshot] = useState("");
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [isAutoScanning, setIsAutoScanning] = useState(false);
  const [cropSettings, setCropSettings] =
    useState<CropSettings>(loadCropSettings);
  const [formatSettings, setFormatSettings] =
    useState<FormatSettings>(loadFormatSettings);
  const [uiSettings, setUiSettings] = useState<UiSettings>(loadUiSettings);

  // ─── 設定の保存 ────────────────────────────────────────────

  useEffect(() => {
    saveJson(CROP_SETTINGS_KEY, cropSettings);
  }, [cropSettings]);

  useEffect(() => {
    saveJson(FORMAT_SETTINGS_KEY, formatSettings);
  }, [formatSettings]);

  useEffect(() => {
    saveJson(UI_SETTINGS_KEY, uiSettings);
  }, [uiSettings]);

  /** 枠の変更はすべてここを通し、はみ出さないように整える */
  const updateCropSettings = useCallback(
    (action: React.SetStateAction<CropSettings>) => {
      setCropSettings((prev) => {
        const next = typeof action === "function" ? action(prev) : action;
        return normalizeCrop(next, prev);
      });
    },
    []
  );

  // ─── 判定ルール（末尾・有効文字） ─────────────────────────

  const rules = useMemo<SerialRules>(
    () => ({
      suffix: sanitizeSuffix(formatSettings.suffix),
      validChars: resolveValidChars(formatSettings),
    }),
    [formatSettings]
  );

  /** OCR に認識させる文字。有効文字（＋末尾の文字）と同じにする */
  const whitelist = useMemo(
    () => [...rules.validChars].sort().join(""),
    [rules]
  );

  // ─── ガイド枠スタイル ──────────────────────────────────────

  const guideStyle = useMemo(() => {
    return {
      left: `${cropSettings.x * 100}%`,
      top: `${cropSettings.y * 100}%`,
      width: `${cropSettings.width * 100}%`,
      height: `${cropSettings.height * 100}%`,
    };
  }, [cropSettings]);

  // ─── キャプチャ & OCR ──────────────────────────────────────

  function captureGuideArea(passCfg?: PassConfig): string | null {
    const video = camera.videoRef.current;
    const canvas = camera.canvasRef.current;
    if (!video || !canvas) return null;
    if (!video.videoWidth || !video.videoHeight) return null;

    // 画面に見えている範囲を基準に、ガイド枠と同じ場所を切り出す
    const { sx, sy, sw, sh } = visibleSourceRect(video);
    const crop = normalizeCrop(cropSettings);

    const cropWidth = Math.max(1, Math.floor(sw * crop.width));
    const cropHeight = Math.max(1, Math.floor(sh * crop.height));
    const cropX = Math.floor(sx + sw * crop.x);
    const cropY = Math.floor(sy + sh * crop.y);

    // 拡大倍率は基本 3 倍。ただし画像が大きくなりすぎる場合は抑える
    const scale = Math.max(
      1,
      Math.min(UPSCALE_FACTOR, MAX_OCR_IMAGE_WIDTH / cropWidth)
    );
    const outW = Math.round(cropWidth * scale);
    const outH = Math.round(cropHeight * scale);

    canvas.width = outW;
    canvas.height = outH;

    // 画素を何度も読み出すので willReadFrequently を指定する
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, outW, outH);

    // 前処理（コントラスト強調 → 二値化）は写真のまとめ読みと共通
    const imageData = ctx.getImageData(0, 0, outW, outH);
    const gray = rgbaToGray(imageData.data, outW, outH);
    const bin = preprocessForOcr(gray, {
      threshold: crop.threshold,
      thresholdOffset: passCfg?.thresholdOffset ?? 0,
      method: passCfg?.method ?? "adaptive",
    });
    grayToRgba(bin, imageData.data);
    ctx.putImageData(imageData, 0, 0);

    return canvas.toDataURL("image/png");
  }

  /** ワーカーを用意し、認識文字を現在の設定にそろえる */
  async function ensureWorker(): Promise<Worker> {
    const Tesseract = await import("tesseract.js");
    if (!ocrWorkerRef.current) {
      camera.setStatusText("認識エンジン初期化中...（初回のみ時間がかかります）");

      // tesseract.js 5.1.1 は、認識データ（約23MB）のダウンロードに失敗しても
      // createWorker がエラーを返さず止まったままになる不具合がある。
      // errorHandler でエラーを受け取り、さらに待ち時間の上限を設けて抜け出す。
      let rejectInit: (reason: Error) => void = () => {};
      const initFailed = new Promise<never>((_, reject) => {
        rejectInit = reject;
      });
      let timeoutId = 0;
      const initTimeout = new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () =>
            reject(
              new Error(
                `${WORKER_INIT_TIMEOUT_MS / 1000}秒たっても準備が終わりませんでした`
              )
            ),
          WORKER_INIT_TIMEOUT_MS
        );
      });

      // legacy エンジン (OEM 0)。LSTM と違い文字単位の代替候補(choices)が
      // 取得でき、等幅シリアルの誤読も少ない。言語データは約23MBで初回ロードが重い。
      const creating = Tesseract.createWorker(
        "eng",
        Tesseract.OEM.TESSERACT_ONLY,
        {
          // legacy 対応のコア／言語データを使用する
          legacyCore: true,
          legacyLang: true,
          logger: (m) => {
            const pct = Math.round((m.progress ?? 0) * 100);
            if (m.status === "recognizing text") {
              camera.setStatusText(`OCR実行中... ${pct}%`);
            } else if (m.status === "loading language traineddata") {
              camera.setStatusText(
                `認識データを読み込み中... ${pct}%（初回のみ約23MB）`
              );
            }
          },
          // 準備中・認識中のエラーを受け取る（指定しないと例外が投げっぱなしになる）
          errorHandler: (e) => {
            rejectInit(new Error(String(e)));
          },
        }
      );

      let settled = false;
      try {
        ocrWorkerRef.current = await Promise.race([
          creating,
          initFailed,
          initTimeout,
        ]);
        settled = true;
      } finally {
        window.clearTimeout(timeoutId);
        // 失敗・時間切れの後で準備が終わったワーカーは使わずに閉じる
        if (!settled) {
          creating.then((w) => w.terminate()).catch(() => {});
        }
      }
      appliedWhitelistRef.current = "";
    }

    const worker = ocrWorkerRef.current;
    // 有効文字を変えたら、次の読み取りからワーカーにも反映する
    if (appliedWhitelistRef.current !== whitelist) {
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
        tessedit_char_whitelist: whitelist,
      });
      appliedWhitelistRef.current = whitelist;
    }
    return worker;
  }

  /** 壊れた可能性のあるワーカーを捨て、次の読み取りで作り直させる */
  async function discardWorker() {
    const worker = ocrWorkerRef.current;
    ocrWorkerRef.current = null;
    appliedWhitelistRef.current = "";
    try {
      await worker?.terminate();
    } catch {
      // すでに落ちている場合は無視
    }
  }

  async function readSerial(options?: { autoSave?: boolean }): Promise<string[]> {
    // 読み取り中に呼ばれたら何もしない（手動と自動の重なり防止）
    if (readingRef.current) return [];
    readingRef.current = true;
    /** どの段階で失敗したかを表示するための目印 */
    let stage: "init" | "recognize" | "aggregate" = "init";

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

      const worker = await ensureWorker();
      stage = "recognize";

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
        const result = await worker.recognize(snapshot, {}, { blocks: true });
        const data = result.data;
        rawTexts.push((data.text ?? "").trim());
        perPassSymbols.push(collectSymbols(data.blocks));
      }

      stage = "aggregate";
      if (firstSnapshot) setLastSnapshot(firstSnapshot);
      setRawText(rawTexts.filter(Boolean).join(" | ") || "(取得失敗)");

      // symbol 単位の確信度＋代替候補で投票集約（第二層の本体）
      let found = aggregateBySymbols(perPassSymbols, rules);

      // 万一 symbol が取れない環境では、生テキストの文字列ベース集約に退避
      if (found.length === 0) {
        const fallback: string[] = [];
        for (const t of rawTexts) {
          fallback.push(...extractRawSerials(t, rules.validChars));
        }
        found = aggregateCandidates(fallback, rules);
      }

      setCandidates(found);
      setSelectedCandidate(found[0] ?? "");

      // 読み取り中にカメラが止められた場合は、停止状態のまま終える
      if (!camera.streamRef.current) {
        camera.setStatus("idle");
        camera.setStatusText("カメラ停止中");
        return found;
      }

      if (isAuto && found[0]) {
        const saved = serialItems.saveCode(found[0], {
          silent: true,
          isAuto: true,
        });
        camera.setStatusText(
          saved
            ? `自動保存: ${found[0]}`
            : `保存済みのためスキップ: ${found[0]}`
        );
      } else {
        const priority = rules.suffix ? `（末尾${rules.suffix}優先）` : "";
        camera.setStatusText(
          found.length > 0
            ? `候補 ${found.length} 件${priority}`
            : "候補なし。位置を合わせ直してください。"
        );
      }

      camera.setStatus("ready");
      return found;
    } catch (error) {
      console.error(error);
      // 失敗したワーカーは使い回さない（使い回すと以降も失敗し続けるため）
      await discardWorker();

      const stageLabel = {
        init: "認識エンジンの準備",
        recognize: "文字の認識",
        aggregate: "候補の集計",
      }[stage];
      const reason = (
        error instanceof Error ? error.message : String(error ?? "")
      ).slice(0, 120);
      const hint =
        stage === "init"
          ? "通信状況を確認して、もう一度読み取ってください。"
          : "もう一度読み取ってください。";
      // 連続スキャン中なら止める（失敗のたびにエンジンを作り直し続けないように）
      const isAuto = options?.autoSave ?? false;
      if (isAuto) setAutoScanEnabled(false);
      camera.setStatusText(
        `OCRに失敗しました（${stageLabel}${reason ? `: ${reason}` : ""}）。${hint}` +
          (isAuto ? "連続スキャンは停止しました。" : "")
      );
      // カメラが動いていれば、そのまま再試行できる状態に戻す
      camera.setStatus(camera.streamRef.current ? "ready" : "idle");
      return [];
    } finally {
      readingRef.current = false;
    }
  }

  // ─── 写真からのまとめ読み ──────────────────────────────────
  //
  // 字形の照合で迷った行だけがここに来る。カメラ枠の読み取りと同じ
  // ワーカー・同じ集約（aggregateBySymbols）を使う。

  async function recognizeLineImages(passImages: GrayImage[]): Promise<string[]> {
    // 認識エンジンはカメラ側の状態表示に進み具合を書くので、終わったら元に戻す
    // （まとめ読みの進み具合は、まとめ読みの欄に出している）
    const cameraStatusText = statusTextRef.current;
    try {
      const worker = await ensureWorker();
      const perPassSymbols: OcrSymbol[][] = [];
      for (const img of passImages) {
        const result = await worker.recognize(
          grayToDataUrl(img),
          {},
          { blocks: true }
        );
        perPassSymbols.push(collectSymbols(result.data.blocks));
      }
      return aggregateBySymbols(perPassSymbols, rules);
    } catch (error) {
      // 失敗したワーカーは使い回さない
      await discardWorker();
      throw error;
    } finally {
      camera.setStatusText(cameraStatusText);
    }
  }

  const savedCodes = useMemo(
    () => new Set(serialItems.items.map((item) => item.code)),
    [serialItems.items]
  );

  function saveBatch(codes: string[]) {
    let saved = 0;
    let skipped = 0;
    for (const code of codes) {
      // 保存済みのものは確認を出さずに飛ばす
      if (serialItems.saveCode(code, { silent: true })) saved++;
      else skipped++;
    }
    return { saved, skipped };
  }

  // ─── 自動スキャン ──────────────────────────────────────────
  //
  // ループは「最新の値」を ref から読む。開始時点の値を閉じ込めないので、
  // 連続スキャン中に枠・末尾・有効文字・間隔を変えても次の読み取りから反映され、
  // オフにすれば読み取り中でも次の予約をしない。

  const statusTextRef = useRef(camera.statusText);
  statusTextRef.current = camera.statusText;
  const readSerialRef = useRef(readSerial);
  readSerialRef.current = readSerial;
  const autoScanEnabledRef = useRef(autoScanEnabled);
  autoScanEnabledRef.current = autoScanEnabled;
  const intervalRef = useRef(uiSettings.autoScanIntervalMs);
  intervalRef.current = clampInterval(uiSettings.autoScanIntervalMs);

  const autoScanTimerRef = useRef<number | null>(null);
  /** ループが動いているか（二重起動の防止） */
  const autoLoopActiveRef = useRef(false);
  /** 停止のたびに増やす番号。古いループが後から再予約しないようにする */
  const autoLoopGenRef = useRef(0);
  const streamRef = camera.streamRef;

  const stopAutoScan = useCallback(() => {
    autoLoopGenRef.current += 1;
    if (autoScanTimerRef.current !== null) {
      window.clearTimeout(autoScanTimerRef.current);
      autoScanTimerRef.current = null;
    }
    autoLoopActiveRef.current = false;
    setIsAutoScanning(false);
  }, []);

  const startAutoScan = useCallback(() => {
    if (autoLoopActiveRef.current) return;
    autoLoopActiveRef.current = true;
    setIsAutoScanning(true);

    const generation = ++autoLoopGenRef.current;
    const isCurrent = () => autoLoopGenRef.current === generation;
    const shouldContinue = () =>
      isCurrent() && autoScanEnabledRef.current && !!streamRef.current;

    const finish = () => {
      if (!isCurrent()) return;
      autoLoopActiveRef.current = false;
      setIsAutoScanning(false);
    };

    const loop = async () => {
      autoScanTimerRef.current = null;
      if (!shouldContinue()) return finish();

      const found = await readSerialRef.current({ autoSave: true });
      if (!shouldContinue()) return finish();

      const interval = intervalRef.current;
      const delay =
        found.length > 0
          ? interval
          : Math.max(interval, AUTO_SCAN_EMPTY_DELAY_MS);
      autoScanTimerRef.current = window.setTimeout(loop, delay);
    };

    autoScanTimerRef.current = window.setTimeout(loop, intervalRef.current);
  }, [streamRef]);

  useEffect(() => {
    const cameraRunning =
      camera.status === "ready" || camera.status === "reading";
    if (autoScanEnabled && cameraRunning && streamRef.current) {
      startAutoScan();
    } else if (!autoScanEnabled || !cameraRunning) {
      // starting 中は待つ。オフ・停止・エラーでは止める
      if (camera.status !== "starting") stopAutoScan();
    }
  }, [autoScanEnabled, camera.status, streamRef, startAutoScan, stopAutoScan]);

  // 画面を閉じるときの後片付け
  useEffect(() => {
    return () => {
      stopAutoScan();
      ocrWorkerRef.current?.terminate();
      ocrWorkerRef.current = null;
    };
  }, [stopAutoScan]);

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
            応募券のシリアルを読み取ります。何枚もあるときは写真でまとめて、
            1 枚ずつのときはカメラで読み取れます。
          </p>
        </div>

        <PhotoBatchPanel
          validChars={rules.validChars}
          threshold={cropSettings.threshold}
          ocrPassOffsets={QUICK_PASSES.map((p) => p.thresholdOffset)}
          runOcr={recognizeLineImages}
          savedCodes={savedCodes}
          onSave={saveBatch}
        />

        <div className="panel">
          <h2 className="section-heading">カメラで 1 枚ずつ読み取る</h2>
          <p className="description">
            カメラ映像のガイド枠を実物のコード文字列に合わせて読み取ります。
          </p>

          <ScanControls
            status={camera.status}
            statusText={camera.statusText}
            autoScanEnabled={autoScanEnabled}
            autoScanIntervalMs={uiSettings.autoScanIntervalMs}
            isAutoScanning={isAutoScanning}
            showAdjuster={uiSettings.showAdjuster}
            lastAutoSavedCode={serialItems.lastAutoSavedCode}
            formatSettings={formatSettings}
            effectiveValidChars={whitelist}
            onStartCamera={camera.startCamera}
            onStopCamera={handleStopCamera}
            onReadSerial={() => readSerial()}
            onAutoScanChange={setAutoScanEnabled}
            onIntervalChange={(ms) =>
              setUiSettings((prev) => ({ ...prev, autoScanIntervalMs: ms }))
            }
            onIntervalCommit={() =>
              setUiSettings((prev) => ({
                ...prev,
                autoScanIntervalMs: clampInterval(prev.autoScanIntervalMs),
              }))
            }
            onToggleAdjuster={() =>
              setUiSettings((prev) => ({
                ...prev,
                showAdjuster: !prev.showAdjuster,
              }))
            }
            onFormatChange={(patch) =>
              setFormatSettings((prev) => ({ ...prev, ...patch }))
            }
            onFormatReset={() => setFormatSettings(DEFAULT_FORMAT_SETTINGS)}
          />

          {uiSettings.showAdjuster && (
            <CropAdjuster
              cropSettings={cropSettings}
              onChange={updateCropSettings}
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
              targetUrl={formatSettings.targetUrl}
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
