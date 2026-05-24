import React from "react";
import type { OcrStatus } from "../types";

type Props = {
  status: OcrStatus;
  statusText: string;
  autoScanEnabled: boolean;
  autoScanIntervalMs: number;
  isAutoScanning: boolean;
  showAdjuster: boolean;
  lastAutoSavedCode: string;
  targetUrl: string;
  onStartCamera: () => void;
  onStopCamera: () => void;
  onReadSerial: () => void;
  onAutoScanChange: (enabled: boolean) => void;
  onIntervalChange: (ms: number) => void;
  onToggleAdjuster: () => void;
  onTargetUrlChange: (url: string) => void;
};

export function ScanControls({
  status,
  statusText,
  autoScanEnabled,
  autoScanIntervalMs,
  isAutoScanning,
  showAdjuster,
  lastAutoSavedCode,
  targetUrl,
  onStartCamera,
  onStopCamera,
  onReadSerial,
  onAutoScanChange,
  onIntervalChange,
  onToggleAdjuster,
  onTargetUrlChange,
}: Props) {
  return (
    <>
      <div className="button-row">
        <button onClick={onStartCamera} className="btn btn-primary">
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
            min={800}
            max={5000}
            step={100}
            value={autoScanIntervalMs}
            onChange={(e) => onIntervalChange(Number(e.target.value) || 1200)}
            className="number-input"
          />
        </label>

        <div className="control-box">
          連続状態: {isAutoScanning ? "実行中" : "停止中"}
        </div>
      </div>

      <div className="control-box">
        <span>遷移URL</span>
        <input
          type="text"
          value={targetUrl}
          onChange={(e) => onTargetUrlChange(e.target.value)}
          className="text-input"
        />
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
