import React, { useState } from "react";
import type { OcrStatus } from "../types";
import type { FormatSettings } from "../constants";
import {
  AUTO_SCAN_INTERVAL_MAX,
  AUTO_SCAN_INTERVAL_MIN,
  sanitizeSuffix,
  sanitizeValidChars,
} from "../constants";

type Props = {
  status: OcrStatus;
  statusText: string;
  autoScanEnabled: boolean;
  autoScanIntervalMs: number;
  isAutoScanning: boolean;
  showAdjuster: boolean;
  lastAutoSavedCode: string;
  formatSettings: FormatSettings;
  /** 実際に使っている有効文字（空欄時の初期値や末尾の文字を含む） */
  effectiveValidChars: string;
  onStartCamera: () => void;
  onStopCamera: () => void;
  onReadSerial: () => void;
  onAutoScanChange: (enabled: boolean) => void;
  onIntervalChange: (ms: number) => void;
  /** 間隔の入力を終えたとき（範囲内に収める） */
  onIntervalCommit: () => void;
  onToggleAdjuster: () => void;
  onFormatChange: (patch: Partial<FormatSettings>) => void;
  onFormatReset: () => void;
};

export function ScanControls({
  status,
  statusText,
  autoScanEnabled,
  autoScanIntervalMs,
  isAutoScanning,
  showAdjuster,
  lastAutoSavedCode,
  formatSettings,
  effectiveValidChars,
  onStartCamera,
  onStopCamera,
  onReadSerial,
  onAutoScanChange,
  onIntervalChange,
  onIntervalCommit,
  onToggleAdjuster,
  onFormatChange,
  onFormatReset,
}: Props) {
  const [showFormat, setShowFormat] = useState(false);
  const validCharsEmpty = sanitizeValidChars(formatSettings.validChars) === "";

  return (
    <>
      <div className="button-row">
        <button
          onClick={onStartCamera}
          disabled={status === "starting"}
          className="btn btn-primary"
        >
          カメラ起動
        </button>
        <button
          onClick={onReadSerial}
          disabled={status !== "ready"}
          className="btn btn-read"
        >
          読み取る
        </button>
        <button onClick={onStopCamera} className="btn btn-secondary">
          カメラ停止
        </button>
        <button onClick={onToggleAdjuster} className="btn btn-secondary">
          {showAdjuster ? "調整を隠す" : "調整を表示"}
        </button>
      </div>

      <div className="control-grid">
        <label className="control-box">
          <input
            type="checkbox"
            checked={autoScanEnabled}
            onChange={(e) => onAutoScanChange(e.target.checked)}
          />
          <span>連続スキャン</span>
        </label>

        <label className="control-box">
          <span>間隔(ms)</span>
          <input
            type="number"
            min={AUTO_SCAN_INTERVAL_MIN}
            max={AUTO_SCAN_INTERVAL_MAX}
            step={100}
            value={autoScanIntervalMs}
            onChange={(e) => onIntervalChange(Number(e.target.value))}
            onBlur={onIntervalCommit}
            className="number-input"
          />
        </label>

        <div className="control-box">
          連続状態: {isAutoScanning ? "実行中" : "停止中"}
        </div>
      </div>

      <div className="format-panel">
        <button
          type="button"
          className="format-toggle"
          onClick={() => setShowFormat((v) => !v)}
          aria-expanded={showFormat}
        >
          <span>
            シングル設定
            <span className="format-summary">
              末尾 {formatSettings.suffix || "（なし）"}
            </span>
          </span>
          <span aria-hidden="true">{showFormat ? "▲" : "▼"}</span>
        </button>

        {showFormat && (
          <div className="format-body">
            <label className="format-field">
              <span className="format-label">末尾</span>
              <input
                type="text"
                value={formatSettings.suffix}
                onChange={(e) =>
                  onFormatChange({ suffix: sanitizeSuffix(e.target.value) })
                }
                className="text-input mono"
                placeholder="例: WT"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="format-hint">
                この末尾で終わる候補を優先します。空欄なら優先しません。
              </span>
            </label>

            <label className="format-field">
              <span className="format-label">有効文字</span>
              <input
                type="text"
                value={formatSettings.validChars}
                onChange={(e) =>
                  onFormatChange({
                    validChars: e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, ""),
                  })
                }
                onBlur={() =>
                  onFormatChange({
                    validChars: sanitizeValidChars(formatSettings.validChars),
                  })
                }
                className="text-input mono"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="format-hint">
                シリアルに使われる文字だけを入れます。ここにない 0・1・2・I・O
                は形の近い文字に置き換えて読みます。
              </span>
              {validCharsEmpty && (
                <span className="format-warning">
                  空欄のため初期値の文字を使っています。
                </span>
              )}
              <span className="format-hint mono">
                使用中: {effectiveValidChars}（{effectiveValidChars.length}文字）
              </span>
            </label>

            <label className="format-field">
              <span className="format-label">応募ページURL</span>
              <input
                type="url"
                value={formatSettings.targetUrl}
                onChange={(e) => onFormatChange({ targetUrl: e.target.value })}
                className="text-input"
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            <button
              type="button"
              onClick={() => {
                if (window.confirm("シングル設定を初期値（15th）に戻しますか？")) {
                  onFormatReset();
                }
              }}
              className="btn btn-small btn-secondary"
            >
              初期値に戻す
            </button>
          </div>
        )}
      </div>

      <div className="status-box">状態: {statusText}</div>

      {lastAutoSavedCode && (
        <div className="auto-save-box">
          直近の自動保存:{" "}
          <span className="mono">{lastAutoSavedCode}</span>
        </div>
      )}
    </>
  );
}
