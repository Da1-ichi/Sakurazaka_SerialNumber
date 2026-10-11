import { useEffect, useMemo, useRef, useState } from "react";
import type { SerialItem } from "../types";
import { STORAGE_KEY } from "../constants";

/** localStorage から保存済み一覧を読む。壊れていれば空にする */
function loadItems(): SerialItem[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? (parsed as SerialItem[]) : [];
  } catch {
    return [];
  }
}

export function useSerialItems() {
  // 初回描画の時点で読み込む（空の一覧で上書き保存してしまうのを防ぐ）
  const [items, setItems] = useState<SerialItem[]>(loadItems);
  const [copiedMessage, setCopiedMessage] = useState("");
  const [lastAutoSavedCode, setLastAutoSavedCode] = useState("");

  // 連続スキャンのループなど、描画をまたいで呼ばれても最新の一覧で判定するための参照
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // localStorage へ同期
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // 容量超過などは無視（画面上の一覧は残る）
    }
  }, [items]);

  // コピーメッセージ自動消去
  useEffect(() => {
    if (!copiedMessage) return;
    const id = window.setTimeout(() => setCopiedMessage(""), 1800);
    return () => window.clearTimeout(id);
  }, [copiedMessage]);

  const duplicateSet = useMemo(() => {
    const count = new Map<string, number>();
    for (const item of items) {
      count.set(item.code, (count.get(item.code) ?? 0) + 1);
    }
    return new Set(
      [...count.entries()].filter(([, v]) => v > 1).map(([k]) => k)
    );
  }, [items]);

  /**
   * コードを保存する。保存したら true、しなかったら false を返す。
   *
   * 重複の扱い（二重応募を防ぐため、一覧全体と照合する）:
   *   - 自動保存: 一覧のどこかに同じコードがあればスキップ
   *   - 手動保存: 同じコードがあれば確認を出し、OK のときだけ保存
   *     （silent のときは確認を出さずにスキップ）
   */
  function saveCode(
    code: string,
    options?: { silent?: boolean; isAuto?: boolean }
  ): boolean {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return false;

    const current = itemsRef.current;
    const exists = current.some((item) => item.code === trimmed);

    if (exists) {
      if (options?.isAuto || options?.silent) return false;
      const ok = window.confirm(
        `${trimmed} はすでに保存されています。もう一度保存しますか？`
      );
      if (!ok) return false;
    }

    const next: SerialItem[] = [
      {
        id: crypto.randomUUID(),
        code: trimmed,
        createdAt: new Date().toISOString(),
      },
      ...current,
    ];
    // 次の描画を待たずに参照を更新し、続けて呼ばれても重複判定が効くようにする
    itemsRef.current = next;
    setItems(next);

    if (options?.isAuto) {
      setLastAutoSavedCode(trimmed);
    }

    return true;
  }

  function addSelected(candidate: string): boolean {
    if (!candidate) return false;
    return saveCode(candidate);
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setItems((prev) =>
        prev.map((item) =>
          item.code === code && !item.copiedAt
            ? { ...item, copiedAt: new Date().toISOString() }
            : item
        )
      );
      setCopiedMessage(`${code} をコピーしました`);
    } catch (error) {
      console.error(error);
      setCopiedMessage("コピーに失敗しました");
    }
  }

  async function copyAll() {
    const text = items.map((item) => item.code).join("\n\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessage("全件コピーしました");
    } catch (error) {
      console.error(error);
      setCopiedMessage("一括コピーに失敗しました");
    }
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function clearAll() {
    if (!window.confirm("保存済みコードを全削除しますか？")) return;
    setItems([]);
    setLastAutoSavedCode("");
  }

  return {
    items,
    copiedMessage,
    lastAutoSavedCode,
    duplicateSet,
    saveCode,
    addSelected,
    copyCode,
    copyAll,
    removeItem,
    clearAll,
  };
}
