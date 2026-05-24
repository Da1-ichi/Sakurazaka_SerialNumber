import React from "react";
import type { SerialItem } from "../types";
import { formatDate } from "../utils/helpers";

type Props = {
  items: SerialItem[];
  duplicateSet: Set<string>;
  copiedMessage: string;
  targetUrl: string;
  onCopyCode: (code: string) => void;
  onCopyAll: () => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
};

export function SavedItemList({
  items,
  duplicateSet,
  copiedMessage,
  targetUrl,
  onCopyCode,
  onCopyAll,
  onRemove,
  onClearAll,
}: Props) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="section-heading">保存済みコード</h2>
        <button
          onClick={() => window.open(targetUrl, "_blank")}
          disabled={items.length === 0}
          className="btn btn-secondary full-width"
        >
          応募ページを開く
        </button>
        <div className="small-button-row">
          <button onClick={onCopyAll} className="btn btn-small btn-secondary">
            全件コピー
          </button>
          <button onClick={onClearAll} className="btn btn-small btn-danger">
            全削除
          </button>
        </div>
      </div>

      {copiedMessage && <div className="copied-box">{copiedMessage}</div>}

      <div className="saved-list">
        {items.length === 0 ? (
          <div className="empty-box">まだ保存されていません</div>
        ) : (
          items.map((item) => (
            <div key={item.id} className="saved-item">
              <div className="saved-left">
                <div className="mono saved-code">{item.code}</div>
                <div className="saved-date">
                  登録: {formatDate(item.createdAt)}
                </div>
                {duplicateSet.has(item.code) && (
                  <div className="duplicate-text">重複あり</div>
                )}
              </div>

              <div className="saved-actions">
                <button
                  onClick={() => onCopyCode(item.code)}
                  className="btn btn-small btn-primary"
                >
                  コピー
                </button>
                <button
                  onClick={() => onRemove(item.id)}
                  className="btn btn-small btn-secondary"
                >
                  削除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
