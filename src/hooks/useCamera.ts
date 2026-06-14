import { useEffect, useRef, useState } from "react";
import type { OcrStatus } from "../types";

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<OcrStatus>("idle");
  const [statusText, setStatusText] = useState("未起動");

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      }
    };
  }, []);

  async function startCamera() {
    try {
      setStatus("starting");
      setStatusText("カメラ起動中...");

      stopCamera();

      // 解像度はできるだけ高く要求する（ideal なので非対応端末は自動で下がる）。
      // 文字あたりのピクセル数が増えるほど OCR 精度が上がるため、
      // ガイド枠に小さく写るシリアルの可読性が改善する。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("video element not found");

      video.srcObject = stream;
      await video.play();

      // ストリーム取得後、ピント・露出を best-effort で最適化する。
      // 端末が対応していない項目は無視される（例外は握りつぶす）。
      await tuneTrack(stream);

      setStatus("ready");
      setStatusText("カメラ準備OK");
    } catch (error) {
      console.error(error);
      setStatus("error");
      setStatusText("カメラ起動失敗。HTTPS とカメラ権限を確認してください。");
    }
  }

  /**
   * 映像トラックのピント・露出を可能な範囲で調整する。
   * - focusMode: continuous … 近接でも合焦し続ける（手持ち撮影のボケ対策）
   * - exposureMode: continuous … 明るさ変動への自動追従
   * getCapabilities で対応を確認してから applyConstraints する。
   * 非対応端末・iOS Safari などでは静かにスキップ。
   */
  async function tuneTrack(stream: MediaStream) {
    try {
      const track = stream.getVideoTracks()[0];
      if (!track || typeof track.getCapabilities !== "function") return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caps = track.getCapabilities() as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const advanced: any[] = [];

      // 連続オートフォーカス（ボケ対策の本命）
      if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
        advanced.push({ focusMode: "continuous" });
      }
      // 連続自動露出
      if (
        Array.isArray(caps.exposureMode) &&
        caps.exposureMode.includes("continuous")
      ) {
        advanced.push({ exposureMode: "continuous" });
      }

      if (advanced.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await track.applyConstraints({ advanced } as any);
      }
    } catch (e) {
      // 対応していない端末では失敗するが、撮影自体は続行できるので無視
      console.warn("camera tuning skipped:", e);
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }

  return {
    videoRef,
    canvasRef,
    streamRef,
    status,
    setStatus,
    statusText,
    setStatusText,
    startCamera,
    stopCamera,
  };
}
