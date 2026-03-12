import React, { useRef, useState } from "react";
import "./styles.css";

const FIX_LAST = "V";

function normalizeChar(c: string) {
  c = c.toUpperCase();

  if (c === "B") return "8";
  if (c === "S") return "3";
  if (c === "5") return "3";
  if (c === "L") return "1";
  if (c === "G") return "6";
  if (c === "O") return "0";

  return c;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [raw, setRaw] = useState("");
  const [candidate, setCandidate] = useState("");

  const [char12, setChar12] = useState("9");
  const [manual12, setManual12] = useState("");

  const twelfth = manual12 || char12;

  async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
  }

  function capture() {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.drawImage(video, 0, 0);

    return canvas;
  }

  async function readSerial() {
  const baseCanvas = capture();

  const w = baseCanvas.width;
  const h = baseCanvas.height;

  const ctx = baseCanvas.getContext("2d")!;

  const cropY = h * 0.5;
  const cropH = h * 0.08;
  const cropX = w * 0.2;
  const cropW = w * 0.65;

  const img = ctx.getImageData(cropX, cropY, cropW, cropH);

  const temp = document.createElement("canvas");
  temp.width = cropW * 3;
  temp.height = cropH * 3;

  const tctx = temp.getContext("2d")!;
  tctx.imageSmoothingEnabled = false;

  const small = document.createElement("canvas");
  small.width = cropW;
  small.height = cropH;
  small.getContext("2d")!.putImageData(img, 0, 0);

  tctx.drawImage(small, 0, 0, temp.width, temp.height);

  const charWidth = temp.width / 11;

  let result = "";

  const Tesseract = await import("tesseract.js");

  for (let i = 0; i < 11; i++) {
    const c = document.createElement("canvas");
    c.width = charWidth;
    c.height = temp.height;

    const cctx = c.getContext("2d")!;
    cctx.drawImage(
      temp,
      i * charWidth,
      0,
      charWidth,
      temp.height,
      0,
      0,
      charWidth,
      temp.height
    );

    const r = await Tesseract.recognize(c, "eng", {
      tessedit_pageseg_mode: "10",
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    });

    let ch = r.data.text.trim();

    if (!ch) ch = "";

    ch = normalizeChar(ch[0] || "");

    result += ch;
  }

  setRaw(result);

  const final = result + twelfth + FIX_LAST;

  setCandidate(final);
}

  return (
    <div className="app-shell">

      <h1>シリアルスキャナ</h1>

      <div>
        <button onClick={startCamera}>カメラ起動</button>
        <button onClick={readSerial}>読み取る</button>
      </div>

      <video ref={videoRef} autoPlay playsInline />

      <canvas ref={canvasRef} style={{ display: "none" }} />

      <div>

        <h3>OCR結果（11文字）</h3>

        <div>{raw}</div>

        <h3>最終コード</h3>

        <div>{candidate}</div>

      </div>

      <div>

        <h3>12文字目</h3>

        <select
          value={char12}
          onChange={e => setChar12(e.target.value)}
        >
          <option value="9">9</option>
          <option value="L">L</option>
        </select>

        <input
          placeholder="手入力"
          maxLength={1}
          value={manual12}
          onChange={e => setManual12(e.target.value.toUpperCase())}
        />

        <div>13文字目: V 固定</div>

      </div>

    </div>
  );
}
