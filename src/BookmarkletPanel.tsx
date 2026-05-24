import React, { useState } from "react";
import { BOOKMARKLET_CODE } from "../constants";

export function BookmarkletPanel() {
  const [showGuide, setShowGuide] = useState(false);

  function handleCopyCode() {
    navigator.clipboard
      .writeText(BOOKMARKLET_CODE)
      .then(() => {
        alert(
          "ブックマークレットをコピーしました。\nブラウザのブックマークに新規追加し、URL欄に貼り付けてください。"
        );
      })
      .catch(() => {
        window.prompt(
          "以下をコピーしてブックマークのURLに貼り付けてください:",
          BOOKMARKLET_CODE
        );
      });
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2 className="section-heading">ブックマークレット</h2>
      <p
        style={{
          fontSize: 13,
          color: "#475569",
          lineHeight: 1.6,
          margin: "8px 0 16px",
        }}
      >
        応募ページで使うツールです。シリアルを最大10件まとめて入力欄に自動入力できます。
      </p>

      <div
        style={{
          background: "#f8fafc",
          borderRadius: 16,
          padding: 16,
          textAlign: "center",
        }}
      >
        <a
          href={BOOKMARKLET_CODE}
          onClick={(e) => e.preventDefault()}
          style={{
            display: "inline-block",
            background: "#7c3aed",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            padding: "12px 24px",
            borderRadius: 16,
            textDecoration: "none",
            cursor: "grab",
          }}
        >
          シリアル一括入力
        </a>
        <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
          PCの方：このボタンをブックマークバーにドラッグ
        </div>
      </div>

      <button
        className="btn btn-small btn-secondary full-width"
        style={{ marginTop: 12 }}
        onClick={handleCopyCode}
      >
        コードをコピー（スマホ用）
      </button>

      <button
        className="btn btn-small btn-secondary full-width"
        style={{ marginTop: 8 }}
        onClick={() => setShowGuide((v) => !v)}
      >
        {showGuide
          ? "▲ 登録手順を閉じる"
          : "▼ 登録手順を見る（初回のみ）"}
      </button>

      {showGuide && (
        <div
          style={{
            marginTop: 12,
            fontSize: 13,
            color: "#334155",
            lineHeight: 1.8,
          }}
        >
          <div
            style={{
              background: "#eff6ff",
              borderRadius: 12,
              padding: 14,
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6, color: "#1d4ed8" }}>
              {"📱 iPhone（Safari）の場合"}
            </div>
            <div>{"1. 上の「コードをコピー」ボタンを押す"}</div>
            <div>{"2. まず適当なページをブックマーク登録する"}</div>
            <div>
              {
                "3. ブックマーク一覧を開き、今登録したブックマークを「編集」"
              }
            </div>
            <div>{"4. 名前を「シリアル一括入力」に変更"}</div>
            <div>
              {
                "5. URL欄を全選択して削除し、コピーしたコードを貼り付け"
              }
            </div>
            <div>{"6. 「完了」で保存"}</div>
          </div>

          <div
            style={{
              background: "#f0fdf4",
              borderRadius: 12,
              padding: 14,
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6, color: "#15803d" }}>
              {"📱 Android（Chrome）の場合"}
            </div>
            <div>{"1. 上の「コードをコピー」ボタンを押す"}</div>
            <div>{"2. まず適当なページをブックマーク登録する"}</div>
            <div>
              {
                "3. 右上 ︙ →「ブックマーク」→ 今登録したブックマークを長押し →「編集」"
              }
            </div>
            <div>{"4. 名前を「シリアル一括入力」に変更"}</div>
            <div>
              {
                "5. URL欄を全選択して削除し、コピーしたコードを貼り付け"
              }
            </div>
            <div>{"6. 「保存」で完了"}</div>
          </div>

          <div
            style={{
              background: "#faf5ff",
              borderRadius: 12,
              padding: 14,
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6, color: "#7c3aed" }}>
              {"💻 PC（Chrome / Edge）の場合"}
            </div>
            <div>
              {
                "上の紫色のボタンをブックマークバーに直接ドラッグ＆ドロップするだけでOK"
              }
            </div>
            <div
              style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}
            >
              {
                "※ ブックマークバーが非表示の場合は Ctrl+Shift+B で表示"
              }
            </div>
          </div>

          <div
            style={{
              background: "#fefce8",
              borderRadius: 12,
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6, color: "#a16207" }}>
              {"🔄 使い方（毎回の手順）"}
            </div>
            <div>{"1. このアプリでシリアルを読み取り・保存する"}</div>
            <div>{"2.「全件コピー」ボタンを押す"}</div>
            <div>{"3.「応募ページを開く」で応募サイトへ移動"}</div>
            <div>
              {
                "4. 登録したブックマーク「シリアル一括入力」をタップ"
              }
            </div>
            <div>{"5. 入力欄に自動入力される"}</div>
          </div>
        </div>
      )}
    </div>
  );
}
