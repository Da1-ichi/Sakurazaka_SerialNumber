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

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("video element not found");

      video.srcObject = stream;
      await video.play();

      setStatus("ready");
      setStatusText("カメラ準備OK");
    } catch (error) {
      console.error(error);
      setStatus("error");
      setStatusText("カメラ起動失敗。HTTPS とカメラ権限を確認してください。");
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
