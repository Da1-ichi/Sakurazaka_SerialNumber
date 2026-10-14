import React, { useState } from "react";
import type { FormatSettings } from "../constants";
import {
  SINGLE_NUMBER_MAX,
  SINGLE_NUMBER_MIN,
  buildTargetUrl,
  sanitizeSingleNumber,
  sanitizeSuffix,
  sanitizeValidChars,
} from "../constants";

type Props = {
  formatSettings: FormatSettings;
  /** 実際に使っている有効文字（空欄時の初期値や末尾の文字を含む） */
  effectiveValidChars: string;
  onChange: (patch: Partial<FormatSettings>) => void;
  onReset: () => void;
};

/** シングルごとの設定（末尾・有効文字・何枚目）。折りたたみ式 */
export function FormatSettingsPanel({
  formatSettings,
  effectiveValidChars,
  onChange,
  onReset,
}: Props) {
  const [open, setOpen] = useState(false);
  const validCharsEmpty = sanitizeValidChars(formatSettings.validChars) === "";
  // 入力途中（空欄など）でも打てるよう、欄の文字列は別に持つ
  const [singleDraft, setSingleDraft] = useState(String(formatSettings.singleNumber));
  const [lastSingle, setLastSingle] = useState(formatSettings.singleNumber);
  if (lastSingle !== formatSettings.singleNumber) {
    // 「初期値に戻す」などで外から変わったとき欄も合わせる
    setLastSingle(formatSettings.singleNumber);
    setSingleDraft(String(formatSettings.singleNumber));
  }
  const singleDraftValid = sanitizeSingleNumber(singleDraft) !== null;

  return (
    <div className="format-panel">
      <button
        type="button"
        className="format-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          シングル設定
          <span className="format-summary">
            末尾 {formatSettings.suffix || "（なし）"}
          </span>
        </span>
        <span aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="format-body">
          <label className="format-field">
            <span className="format-label">末尾</span>
            <input
              type="text"
              value={formatSettings.suffix}
              onChange={(e) => onChange({ suffix: sanitizeSuffix(e.target.value) })}
              className="text-input mono"
              placeholder="例: WT"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="format-hint">
              この末尾で終わらないシリアルに「末尾が違う」と表示し、保存のチェックを外します
              （別シングルの券が混ざっていないかの確認用）。空欄なら確認しません。
            </span>
          </label>

          <label className="format-field">
            <span className="format-label">有効文字</span>
            <input
              type="text"
              value={formatSettings.validChars}
              onChange={(e) =>
                onChange({
                  validChars: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                })
              }
              onBlur={() =>
                onChange({ validChars: sanitizeValidChars(formatSettings.validChars) })
              }
              className="text-input mono"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="format-hint">
              シリアルに使われる文字だけを入れます。読み取りはこの文字の中から選びます。
            </span>
            {validCharsEmpty && (
              <span className="format-warning">空欄のため初期値の文字を使っています。</span>
            )}
            <span className="format-hint mono">
              使用中: {effectiveValidChars}（{effectiveValidChars.length}文字）
            </span>
          </label>

          <label className="format-field">
            <span className="format-label">何枚目のシングル</span>
            <input
              type="number"
              inputMode="numeric"
              min={SINGLE_NUMBER_MIN}
              max={SINGLE_NUMBER_MAX}
              step={1}
              value={singleDraft}
              onChange={(e) => {
                const text = e.target.value.replace(/[^0-9]/g, "");
                setSingleDraft(text);
                const n = sanitizeSingleNumber(text);
                if (n !== null) onChange({ singleNumber: n });
              }}
              onBlur={() => setSingleDraft(String(formatSettings.singleNumber))}
              className="text-input mono"
              autoComplete="off"
            />
            {!singleDraftValid && (
              <span className="format-warning">
                {SINGLE_NUMBER_MIN}〜{SINGLE_NUMBER_MAX}
                の数字を入れてください。いまは{formatSettings.singleNumber}
                枚目のまま使っています。
              </span>
            )}
            <span className="format-hint">
              応募ページ: {buildTargetUrl(formatSettings.singleNumber)}
            </span>
          </label>

          <button
            type="button"
            onClick={() => {
              if (window.confirm("シングル設定を初期値（15th）に戻しますか？")) onReset();
            }}
            className="btn btn-small btn-secondary"
          >
            初期値に戻す
          </button>
        </div>
      )}
    </div>
  );
}
