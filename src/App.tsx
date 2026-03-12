import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";

const STORAGE_KEY = "serial-reader-items";
const CROP_SETTINGS_KEY = "serial-reader-crop-settings";
const FIX_LAST = "V";

type SerialItem = {
  id: string;
  code: string;
  createdAt: string;
};

type CropSettings = {
  x: number;
  y: number;
  width: number;
  height: number;
  threshold: number;
};

const DEFAULT_CROP: CropSettings = {
  x: 0.2,
  y: 0.5,
  width: 0.65,
  height: 0.085,
  threshold: 120,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeChar(c: string) {
  const ch = c.toUpperCase();

  if (ch === "B") return "8";
  if (ch === "S") return "3";
  if (ch === "5") return "3";
  if (ch === "L") return "1";
  if (ch === "I") return "1";
  if (ch === "G") return "6";
  if (ch === "O") return "0";
  if (ch === "Q") return "9";
  if (ch === "D") return "0";

  return ch;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ja-JP");
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [items, setItems] = useState<SerialItem[]>([]);
  const [raw, setRaw] = useState("");
  const [candidate, setCandidate] = useState("");
  const [statusText, setStatusText] = useState("未起動");

  const [fixed12, setFixed12] = useState("9");
  const [manual12, setManual12] = useState("");

  const [crop, setCrop] = useState<CropSettings>(DEFAULT_CROP);
  const [showAdjuster, setShowAdjuster] = useState(true);

  const twelfth = (manual12 || fixed12).toUpperCase().slice(0, 1);

  useEffect(() => {
    const savedItems = localStorage.getItem(STORAGE_KEY);
    if (savedItems) {
      try {
        setItems(JSON.parse(savedItems));
      } catch {
        // ignore
      }
    }

    const savedCrop = localStorage.getItem(CROP_SETTINGS_KEY);
    if (savedCrop) {
      try {
        const parsed = JSON.parse(savedCrop) as CropSettings;
        setCrop({
          x: clamp(parsed.x ?? DEFAULT_CROP.x, 0, 0.95),
          y: clamp(parsed.y ?? DEFAULT_CROP.y, 0, 0.95),
          width: clamp(parsed.width ?? DEFAULT_CROP.width, 0.05, 0.95),
          height: clamp(parsed.height ?? DEFAULT_CROP.height, 0.03, 0.3),
          threshold: clamp(parsed.threshold ?? DEFAULT_CROP.threshold, 80, 240),
        });
      } catch {
        // ignore
      }
    }

    return () => {
      stopCamera();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  useEffect(() => {
    localStorage.setItem(CROP_SETTINGS_KEY, JSON.stringify(crop));
  }, [crop]);

  const guideStyle = useMemo(
    () => ({
      left: `${crop.x * 100}%`,
      top: `${crop.y * 100}%`,
      width: `${crop.width * 100}%`,
      height: `${crop.height * 100}%`,
    }),
    [crop]
  );

  async function startCamera() {
    try {
      setStatusText("カメラ起動中...");

      stopCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setStatusText("カメラ準備OK");
    } catch (error) {
      console.error(error);
      setStatusText("カメラ起動失敗");
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  function captureBaseCanvas() {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas) return null;
    if (!video.videoWidth || !video.videoHeight) return null;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function extractCharacterCanvases(baseCanvas: HTMLCanvasElement) {
    const w = baseCanvas.width;
    const h = baseCanvas.height;
    const ctx = baseCanvas.getContext("2d");
    if (!ctx) return [];

    const cropX = Math.floor(w * crop.x);
    const cropY = Math.floor(h * crop.y);
    const cropW = Math.floor(w * crop.width);
    const cropH = Math.floor(h * crop.height);

    const image = ctx.getImageData(cropX, cropY, cropW, cropH);

    const small = document.createElement("canvas");
    small.width = cropW;
    small.height = cropH;
    const sctx = small.getContext("2d");
    if (!sctx) return [];
    sctx.putImageData(image, 0, 0);

    const scaled = document.createElement("canvas");
    scaled.width = cropW * 3;
    scaled.height = cropH * 3;
    const xctx = scaled.getContext("2d");
    if (!xctx) return [];
    xctx.imageSmoothingEnabled = false;
    xctx.drawImage(small, 0, 0, scaled.width, scaled.height);

    const processedImage = xctx.getImageData(0, 0, scaled.width, scaled.height);
    const data = processedImage.data;

    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const v = avg > crop.threshold ? 255 : 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
    xctx.putImageData(processedImage, 0, 0);

    const charWidth = scaled.width / 11;
    const chars: HTMLCanvasElement[] = [];

    for (let i = 0; i < 11; i += 1) {
      const c = document.createElement("canvas");
      c.width = Math.floor(charWidth);
      c.height = scaled.height;

      const cctx = c.getContext("2d");
      if (!cctx) continue;

      cctx.drawImage(
        scaled,
        Math.floor(i * charWidth),
        0,
        Math.floor(charWidth),
        scaled.height,
        0,
        0,
        Math.floor(charWidth),
        scaled.height
      );

      chars.push(c);
    }

    return chars;
  }

  async function readSerial() {
    try {
      setStatusText("OCR実行中...");

      const baseCanvas = captureBaseCanvas();
      if (!baseCanvas) {
        setStatusText("カメラ映像を取得できません");
        return;
      }

      const charCanvases = extractCharacterCanvases(baseCanvas);
      if (charCanvases.length !== 11) {
        setStatusText("文字切り出しに失敗しました");
        return;
      }

      const Tesseract = await import("tesseract.js");

      let result = "";

      for (const charCanvas of charCanvases) {
        const r = await Tesseract.recognize(charCanvas, "eng");
        let ch = r.data.text.trim().toUpperCase();
        ch = normalizeChar(ch[0] || "");

        if (!/^[A-Z0-9]$/.test(ch)) {
          ch = "";
        }

        result += ch;
      }

      setRaw(result);

      const first11 = result.slice(0, 11);
      const finalCode = first11 + twelfth + FIX_LAST;

      setCandidate(finalCode);
      setStatusText(finalCode.length === 13 ? "読み取り完了" : "候補生成失敗");
    } catch (error) {
      console.error(error);
      setStatusText("OCRに失敗しました");
    }
  }

  function save() {
    if (!candidate || candidate.length !== 13) return;

    if (items[0]?.code === candidate) {
      setStatusText(`同一コードを連続保存しないようスキップ: ${candidate}`);
      return;
    }

    setItems((prev) => [
      {
        id: crypto.randomUUID(),
        code: candidate,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);

    setStatusText(`保存しました: ${candidate}`);
  }

  function resetCrop() {
    setCrop(DEFAULT_CROP);
  }

  return (
    <div className="app-shell">
      <div className="app-container">
        <div className="panel">
          <h1 className="title">シリアル読み取り</h1>
          <p className="description">
            先頭11文字をOCRで読み取り、12文字目は指定、13文字目はV固定で生成します。
          </p>

          <div className="button-row">
            <button onClick={startCamera} className="btn btn-primary">
              カメラ起動
            </button>
            <button onClick={readSerial} className="btn btn-read">
              読み取る
            </button>
            <button onClick={stopCamera} className="btn btn-secondary">
              停止
            </button>
            <button onClick={() => setShowAdjuster((v) => !v)} className="btn btn-secondary">
              {showAdjuster ? "調整を隠す" : "調整を表示"}
            </button>
          </div>

          <div className="control-grid">
            <label className="control-box">
              <span>12文字目</span>
              <select value={fixed12} onChange={(e) => setFixed12(e.target.value)} className="number-input">
                <option value="9">9</option>
                <option value="L">L</option>
              </select>
            </label>

            <label className="control-box">
              <span>12文字目 手入力</span>
              <input
                value={manual12}
                maxLength={1}
                onChange={(e) => setManual12(e.target.value.toUpperCase())}
                className="number-input"
                placeholder="任意"
              />
            </label>

            <div className="control-box">13文字目: V 固定</div>
          </div>

          {showAdjuster && (
            <div className="adjuster-panel">
              <div className="adjuster-header">
                <strong>切り抜き調整</strong>
                <button onClick={resetCrop} className="btn btn-small btn-secondary" type="button">
                  初期値に戻す
                </button>
              </div>

              <div className="adjuster-grid">
                <label className="slider-row">
                  <span>X: {crop.x.toFixed(3)}</span>
                  <input
                    type="range"
                    min="0"
                    max="0.8"
                    step="0.005"
                    value={crop.x}
                    onChange={(e) => setCrop((prev) => ({ ...prev, x: Number(e.target.value) }))}
                  />
                </label>

                <label className="slider-row">
                  <span>Y: {crop.y.toFixed(3)}</span>
                  <input
                    type="range"
                    min="0"
                    max="0.95"
                    step="0.005"
                    value={crop.y}
                    onChange={(e) => setCrop((prev) => ({ ...prev, y: Number(e.target.value) }))}
                  />
                </label>

                <label className="slider-row">
                  <span>幅: {crop.width.toFixed(3)}</span>
                  <input
                    type="range"
                    min="0.1"
                    max="0.9"
                    step="0.005"
                    value={crop.width}
                    onChange={(e) => setCrop((prev) => ({ ...prev, width: Number(e.target.value) }))}
                  />
                </label>

                <label className="slider-row">
                  <span>高さ: {crop.height.toFixed(3)}</span>
                  <input
                    type="range"
                    min="0.03"
                    max="0.25"
                    step="0.005"
                    value={crop.height}
                    onChange={(e) => setCrop((prev) => ({ ...prev, height: Number(e.target.value) }))}
                  />
                </label>

                <label className="slider-row">
                  <span>しきい値: {crop.threshold}</span>
                  <input
                    type="range"
                    min="80"
                    max="240"
                    step="1"
                    value={crop.threshold}
                    onChange={(e) => setCrop((prev) => ({ ...prev, threshold: Number(e.target.value) }))}
                  />
                </label>
              </div>
            </div>
          )}

          <div className="status-box">状態: {statusText}</div>
        </div>

        <div className="main-grid">
          <div className="panel">
            <div className="camera-frame">
              <video ref={videoRef} autoPlay playsInline className="camera-video" />

              <div className="camera-overlay">
                <div className="camera-dim" />
                <div className="guide-box-manual" style={guideStyle} />
                <div className="guide-label-manual">この枠に先頭11文字を合わせる</div>
              </div>
            </div>

            <canvas ref={canvasRef} className="hidden-canvas" />

            <div className="preview-grid">
              <div>
                <h2 className="section-title">OCR結果（11文字）</h2>
                <div className="preview-box">{raw || "まだ読み取り結果はありません"}</div>
              </div>

              <div>
                <h2 className="section-title">最終コード</h2>
                <div className="preview-box mono">{candidate || "まだ候補はありません"}</div>
              </div>
            </div>

            <button onClick={save} disabled={!candidate || candidate.length !== 13} className="btn btn-save full-width">
              保存
            </button>
          </div>

          <div className="side-column">
            <div className="panel">
              <h2 className="section-heading">保存済みコード</h2>

              <div className="saved-list">
                {items.length === 0 ? (
                  <div className="empty-box">まだ保存されていません</div>
                ) : (
                  items.map((item) => (
                    <div key={item.id} className="saved-item">
                      <div className="saved-left">
                        <div className="mono saved-code">{item.code}</div>
                        <div className="saved-date">登録: {formatDate(item.createdAt)}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
