import { useEffect, useMemo, useState } from "react";
import type { SerialItem } from "../types";
import { STORAGE_KEY } from "../constants";

export function useSerialItems() {
  const [items, setItems] = useState<SerialItem[]>([]);
  const [copiedMessage, setCopiedMessage] = useState("");
  const [lastAutoSavedCode, setLastAutoSavedCode] = useState("");

  // localStorage から復元
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setItems(JSON.parse(saved) as SerialItem[]);
      } catch {
        // ignore
      }
    }
  }, []);

  // localStorage へ同期
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
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

  function saveCode(
    code: string,
    options?: { silent?: boolean; isAuto?: boolean }
  ): boolean {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return false;

    let didSave = false;

    setItems((prev) => {
      if (prev[0]?.code === trimmed) {
        return prev;
      }
      didSave = true;
      return [
        {
          id: crypto.randomUUID(),
          code: trimmed,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ];
    });

    if (didSave && options?.isAuto) {
      setLastAutoSavedCode(trimmed);
    }

    return didSave;
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
