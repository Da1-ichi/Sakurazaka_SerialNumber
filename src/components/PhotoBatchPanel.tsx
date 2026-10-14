import React, { useMemo, useRef, useState } from "react";
import { readSerialsFromPhoto } from "../utils/photoRead";
import type { GrayImage } from "../utils/image";
import { grayToDataUrl, loadPhotoGray } from "../utils/photoDecode";
import { SERIAL_LENGTH } from "../constants";

type Props = {
  validChars: Set<string>;
  /** 二値化の調整（調整パネルのしきい値） */
  threshold: number;
  /** OCR に渡す前処理の種類 */
  ocrPassOffsets: number[];
  /** 前処理済みの行画像（パスごと）を OCR にかけ、候補を良い順で返す */
  runOcr: (passImages: GrayImage[]) => Promise<string[]>;
  /** 保存済みのシリアル */
  savedCodes: Set<string>;
  /** まとめて保存する。保存した件数と、保存済みのため飛ばした件数を返す */
  onSave: (codes: string[]) => { saved: number; skipped: number };
};

type Row = {
  id: string;
  /** 何枚目の写真か（1 始まり） */
  photo: number;
  code: string;
  /** 読み取った時点の値（手で直したかの判定用） */
  readCode: string;
  hints: { index: number; options: string[] }[];
  /** 字形の照合ができず、OCR だけで読んだ */
  ocrOnly: boolean;
  imageUrl: string;
  include: boolean;
  /** この画面から保存した */
  savedHere: boolean;
};

const yieldToBrowser = () => new Promise((r) => window.setTimeout(r, 0));

export function PhotoBatchPanel({
  validChars,
  threshold,
  ocrPassOffsets,
  runOcr,
  savedCodes,
  onSave,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");

  /** 形式が正しいか（13 桁・有効文字のみ） */
  const isValid = (code: string) =>
    code.length === SERIAL_LENGTH && [...code].every((ch) => validChars.has(ch));

  /** 一覧の中で 2 回目以降に出てくるシリアル（同じ券を 2 回写した場合など） */
  const repeatedIds = useMemo(() => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const row of rows) {
      if (!row.code) continue;
      if (seen.has(row.code)) repeated.add(row.id);
      seen.add(row.code);
    }
    return repeated;
  }, [rows]);

  const needsCheck = (row: Row) => row.hints.length > 0 || row.ocrOnly;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || busy) return;
    setBusy(true);
    setRows([]);
    const found: Row[] = [];
    let ocrFailed = false;

    try {
      const list = [...files];
      for (let p = 0; p < list.length; p++) {
        const label = list.length > 1 ? `写真 ${p + 1}/${list.length}: ` : "";
        setStatusText(`${label}写真を読み込み中...`);
        await yieldToBrowser();

        let photo: GrayImage;
        try {
          photo = await loadPhotoGray(list[p]);
        } catch (error) {
          console.error(error);
          setStatusText(`${label}写真を開けませんでした`);
          continue;
        }

        setStatusText(`${label}シリアルの位置を探しています...`);
        await yieldToBrowser();

        const results = await readSerialsFromPhoto(photo, {
          validChars,
          threshold,
          ocrPassOffsets,
          ocr: runOcr,
          onProgress: (done, total, needsOcr) => {
            setStatusText(
              needsOcr
                ? `${label}${done + 1}/${total} 行目を詳しく読み取り中...（初回は認識データの読み込みに時間がかかります）`
                : `${label}${done}/${total} 行を読み取りました`
            );
          },
          onOcrError: () => {
            ocrFailed = true;
          },
        });

        for (const [i, r] of results.entries()) {
          if (!r.code) continue;
          const row: Row = {
            id: `${p}-${i}`,
            photo: p + 1,
            code: r.code,
            readCode: r.code,
            hints: r.hints,
            ocrOnly: r.method === "ocr",
            imageUrl: grayToDataUrl(r.image, "image/jpeg"),
            include: false,
            savedHere: false,
          };
          found.push(row);
        }
        await yieldToBrowser();
      }

      // 初期のチェック: 迷いなし・形式どおり・未保存・一覧内で初出のものだけ
      const seen = new Set<string>();
      for (const row of found) {
        row.include =
          !needsCheck(row) &&
          isValid(row.code) &&
          !savedCodes.has(row.code) &&
          !seen.has(row.code);
        seen.add(row.code);
      }
      setRows(found);

      const checkCount = found.filter(needsCheck).length;
      if (found.length === 0) {
        setStatusText(
          "シリアルが見つかりませんでした。明るい場所で、応募券がまっすぐ・なるべく大きく写るように撮り直してください。"
        );
      } else {
        setStatusText(
          `${found.length} 件見つかりました` +
            (checkCount > 0
              ? `。うち ${checkCount} 件は要確認です（画像と見比べて、正しければチェックしてください）`
              : "") +
            (ocrFailed ? "。一部の行で詳しい読み取りに失敗しました" : "")
        );
      }
    } catch (error) {
      console.error(error);
      setStatusText(
        `読み取りに失敗しました（${error instanceof Error ? error.message : String(error)}）`
      );
    } finally {
      setBusy(false);
      // 同じ写真をもう一度選んでも読み込めるように
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function updateRow(id: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  const selected = rows.filter(
    (r) => r.include && isValid(r.code) && !repeatedIds.has(r.id)
  );

  function handleSave() {
    const codes = selected.map((r) => r.code);
    if (codes.length === 0) return;
    const { saved, skipped } = onSave(codes);
    const ids = new Set(selected.map((r) => r.id));
    setRows((prev) =>
      prev.map((r) => (ids.has(r.id) ? { ...r, include: false, savedHere: true } : r))
    );
    setStatusText(
      `${saved} 件保存しました` +
        (skipped > 0 ? `（${skipped} 件は保存済みのため飛ばしました）` : "")
    );
  }

  return (
    <div className="panel">
      <h2 className="section-heading">写真からまとめて読み取る</h2>
      <p className="description">
        応募券を何枚か並べて撮った写真から、シリアルをまとめて読み取ります。
        券がまっすぐ・なるべく大きく写るように撮ると精度が上がります。
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden-file-input"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div className="button-row">
        <button
          className="btn btn-read"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          {busy ? "読み取り中..." : "写真を選ぶ・撮る"}
        </button>
        {rows.length > 0 && !busy && (
          <button
            className="btn btn-secondary"
            onClick={() => {
              setRows([]);
              setStatusText("");
            }}
          >
            結果を消す
          </button>
        )}
      </div>

      {statusText && <div className="status-box batch-status">{statusText}</div>}

      {rows.length > 0 && (
        <>
          <div className="batch-list">
            {rows.map((row, i) => {
              const valid = isValid(row.code);
              const alreadySaved = savedCodes.has(row.code) && !row.savedHere;
              const repeated = repeatedIds.has(row.id);
              const check = needsCheck(row) && !row.savedHere;
              const edited = row.code !== row.readCode;
              return (
                <div
                  key={row.id}
                  className={
                    "batch-row" +
                    (check ? " batch-row-check" : "") +
                    (row.savedHere ? " batch-row-done" : "")
                  }
                >
                  <label className="batch-row-head">
                    <input
                      type="checkbox"
                      checked={row.include}
                      disabled={!valid || repeated || row.savedHere}
                      onChange={(e) => updateRow(row.id, { include: e.target.checked })}
                    />
                    <span className="batch-index">
                      {rows.some((r) => r.photo > 1) ? `${row.photo}-` : ""}
                      {i + 1}
                    </span>
                    {row.savedHere && <span className="badge badge-done">保存しました</span>}
                    {check && <span className="badge badge-check">要確認</span>}
                    {alreadySaved && <span className="badge badge-muted">保存済み</span>}
                    {repeated && <span className="badge badge-muted">重複</span>}
                    {edited && <span className="badge badge-muted">修正済み</span>}
                  </label>

                  <img
                    src={row.imageUrl}
                    alt={`読み取った行 ${i + 1}`}
                    className="batch-line-image"
                  />

                  <input
                    type="text"
                    value={row.code}
                    maxLength={SERIAL_LENGTH}
                    className="text-input mono batch-code-input"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={row.savedHere}
                    onChange={(e) =>
                      updateRow(row.id, {
                        code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                      })
                    }
                  />

                  {check && row.ocrOnly && (
                    <div className="batch-hint">
                      字形で照合できなかったため、文字認識だけで読みました。全体を画像と見比べてください。
                    </div>
                  )}
                  {check &&
                    row.hints.map((h) => (
                      <div key={h.index} className="batch-hint">
                        左から {h.index + 1} 文字目:{" "}
                        <span className="mono">{h.options.join(" / ")}</span>{" "}
                        {h.options.length === 2 ? "のどちらか" : "のどれか"}
                        （画像と見比べてください）
                      </div>
                    ))}
                  {!valid && (
                    <div className="format-warning">
                      13 桁の英数字（有効文字のみ）にしてください
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <button
            className="btn btn-save full-width"
            disabled={selected.length === 0}
            onClick={handleSave}
          >
            チェックした {selected.length} 件を保存
          </button>
        </>
      )}
    </div>
  );
}
