import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Worker } from "tesseract.js";
import "./styles.css";

import {
  DEFAULT_FORMAT_SETTINGS,
  FORMAT_SETTINGS_KEY,
  OCR_PASS_OFFSETS,
  WORKER_INIT_TIMEOUT_MS,
  resolveValidChars,
  sanitizeSuffix,
  sanitizeValidChars,
  sanitizeSingleNumber,
  singleNumberFromUrl,
  buildTargetUrl,
} from "./constants";
import type { FormatSettings } from "./constants";
import { aggregateBySymbols, collectSymbols } from "./utils/ocr";
import type { OcrSymbol, SerialRules } from "./utils/ocr";
import type { GrayImage } from "./utils/image";
import { grayToDataUrl } from "./utils/photoDecode";

import { useSerialItems } from "./hooks/useSerialItems";

import { PhotoBatchPanel } from "./components/PhotoBatchPanel";
import { FormatSettingsPanel } from "./components/FormatSettingsPanel";
import { BookmarkletPanel } from "./components/BookmarkletPanel";
import { SavedItemList } from "./components/SavedItemList";

// ─── 設定の読み込み ──────────────────────────────────────────

function loadFormatSettings(): FormatSettings {
  try {
    const raw = localStorage.getItem(FORMAT_SETTINGS_KEY);
    // 以前は応募 URL（targetUrl）を直接保存していたので、そこからも枚数を拾う
    const saved = raw
      ? (JSON.parse(raw) as (Partial<FormatSettings> & { targetUrl?: unknown }) | null)
      : null;
    if (!saved || typeof saved !== "object") return DEFAULT_FORMAT_SETTINGS;
    return {
      suffix:
        typeof saved.suffix === "string"
          ? sanitizeSuffix(saved.suffix)
          : DEFAULT_FORMAT_SETTINGS.suffix,
      validChars:
        typeof saved.validChars === "string"
          ? sanitizeValidChars(saved.validChars)
          : DEFAULT_FORMAT_SETTINGS.validChars,
      singleNumber:
        sanitizeSingleNumber(saved.singleNumber) ??
        (typeof saved.targetUrl === "string"
          ? singleNumberFromUrl(saved.targetUrl)
          : null) ??
        DEFAULT_FORMAT_SETTINGS.singleNumber,
    };
  } catch {
    return DEFAULT_FORMAT_SETTINGS;
  }
}

// ─── メインコンポーネント ────────────────────────────────────

export default function SerialReaderPrototype() {
  const serialItems = useSerialItems();

  const ocrWorkerRef = useRef<Worker | null>(null);
  /** ワーカーに現在設定してある認識文字（変わったときだけ設定し直す） */
  const appliedWhitelistRef = useRef("");

  const [formatSettings, setFormatSettings] =
    useState<FormatSettings>(loadFormatSettings);
  /** 認識エンジンの準備の進み具合（まとめ読みの欄に表示） */
  const [engineStatus, setEngineStatus] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(FORMAT_SETTINGS_KEY, JSON.stringify(formatSettings));
    } catch {
      // 保存できなくても画面の動作は続ける
    }
  }, [formatSettings]);

  // ─── 判定ルール（末尾・有効文字） ─────────────────────────

  const rules = useMemo<SerialRules>(
    () => ({
      suffix: sanitizeSuffix(formatSettings.suffix),
      validChars: resolveValidChars(formatSettings),
    }),
    [formatSettings]
  );

  /** OCR に認識させる文字。有効文字（＋末尾の文字）と同じにする */
  const whitelist = useMemo(() => [...rules.validChars].sort().join(""), [rules]);

  // ─── 認識エンジン（Tesseract） ─────────────────────────────
  //
  // まとめ読みは字形の照合が主で、字形で迷った行だけがここに来る。

  /** ワーカーを用意し、認識文字を現在の設定にそろえる */
  async function ensureWorker(): Promise<Worker> {
    const Tesseract = await import("tesseract.js");
    if (!ocrWorkerRef.current) {
      setEngineStatus("認識エンジン初期化中...（初回のみ時間がかかります）");

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
      const creating = Tesseract.createWorker("eng", Tesseract.OEM.TESSERACT_ONLY, {
        legacyCore: true,
        legacyLang: true,
        logger: (m) => {
          if (m.status === "loading language traineddata") {
            const pct = Math.round((m.progress ?? 0) * 100);
            setEngineStatus(`認識データを読み込み中... ${pct}%（初回のみ約23MB）`);
          }
        },
        // 準備中・認識中のエラーを受け取る（指定しないと例外が投げっぱなしになる）
        errorHandler: (e) => {
          rejectInit(new Error(String(e)));
        },
      });

      let settled = false;
      try {
        ocrWorkerRef.current = await Promise.race([creating, initFailed, initTimeout]);
        settled = true;
      } finally {
        window.clearTimeout(timeoutId);
        setEngineStatus("");
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

  /** 前処理済みの行画像（パスごと）を OCR にかけ、候補を良い順で返す */
  async function recognizeLineImages(passImages: GrayImage[]): Promise<string[]> {
    try {
      const worker = await ensureWorker();
      const perPassSymbols: OcrSymbol[][] = [];
      for (const img of passImages) {
        // blocks:true で文字単位(symbol)の確信度・代替候補を取得する
        const result = await worker.recognize(grayToDataUrl(img), {}, { blocks: true });
        perPassSymbols.push(collectSymbols(result.data.blocks));
      }
      // 末尾は優先しない（別シングルの券を設定の末尾に寄せて読まないように。
      // 末尾の違いは、まとめ読みの欄で「末尾が違う」として知らせる）
      return aggregateBySymbols(perPassSymbols, { ...rules, suffix: "" });
    } catch (error) {
      // 失敗したワーカーは使い回さない（使い回すと以降も失敗し続けるため）
      await discardWorker();
      throw error;
    }
  }

  // 画面を閉じるときの後片付け
  useEffect(() => {
    return () => {
      ocrWorkerRef.current?.terminate();
      ocrWorkerRef.current = null;
    };
  }, []);

  // ─── 保存 ──────────────────────────────────────────────────

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

  // ─── レンダリング ──────────────────────────────────────────

  return (
    <div className="app-shell">
      <div className="app-container">
        <div className="panel">
          <h1 className="title">シリアル読み取り試作版</h1>
          <p className="description">
            応募券を並べて撮った写真から、シリアルをまとめて読み取ります。
          </p>
        </div>

        <PhotoBatchPanel
          validChars={rules.validChars}
          suffix={rules.suffix}
          ocrPassOffsets={OCR_PASS_OFFSETS}
          runOcr={recognizeLineImages}
          engineStatus={engineStatus}
          savedCodes={savedCodes}
          onSave={saveBatch}
          settings={
            <FormatSettingsPanel
              formatSettings={formatSettings}
              effectiveValidChars={whitelist}
              onChange={(patch) => setFormatSettings((prev) => ({ ...prev, ...patch }))}
              onReset={() => setFormatSettings(DEFAULT_FORMAT_SETTINGS)}
            />
          }
        />

        <SavedItemList
          items={serialItems.items}
          duplicateSet={serialItems.duplicateSet}
          copiedMessage={serialItems.copiedMessage}
          targetUrl={buildTargetUrl(formatSettings.singleNumber)}
          onCopyCode={serialItems.copyCode}
          onCopyAll={serialItems.copyAll}
          onRemove={serialItems.removeItem}
          onClearAll={serialItems.clearAll}
        />

        <BookmarkletPanel />
      </div>
    </div>
  );
}
