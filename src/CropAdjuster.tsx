import React from "react";
import type { CropSettings } from "../types";

type Props = {
  cropSettings: CropSettings;
  onChange: React.Dispatch<React.SetStateAction<CropSettings>>;
  onReset: () => void;
};

export function CropAdjuster({ cropSettings, onChange, onReset }: Props) {
  const sliders: {
    label: string;
    key: keyof CropSettings;
    min: number;
    max: number;
    step: number;
    format: (v: number) => string;
  }[] = [
    { label: "X", key: "x", min: 0, max: 0.8, step: 0.005, format: (v) => v.toFixed(3) },
    { label: "Y", key: "y", min: 0, max: 0.95, step: 0.005, format: (v) => v.toFixed(3) },
    { label: "幅", key: "width", min: 0.1, max: 0.9, step: 0.005, format: (v) => v.toFixed(3) },
    { label: "高さ", key: "height", min: 0.03, max: 0.25, step: 0.005, format: (v) => v.toFixed(3) },
    { label: "しきい値", key: "threshold", min: 80, max: 240, step: 1, format: (v) => String(v) },
  ];

  return (
    <div className="adjuster-panel">
      <div className="adjuster-header">
        <strong>切り抜き調整</strong>
        <button onClick={onReset} className="btn btn-small btn-secondary" type="button">
          初期値に戻す
        </button>
      </div>

      <div className="adjuster-grid">
        {sliders.map(({ label, key, min, max, step, format }) => (
          <label key={key} className="slider-row">
            <span>
              {label}: {format(cropSettings[key])}
            </span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={cropSettings[key]}
              onChange={(e) =>
                onChange((prev) => ({ ...prev, [key]: Number(e.target.value) }))
              }
            />
          </label>
        ))}
      </div>
    </div>
  );
}
