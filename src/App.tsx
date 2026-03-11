import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";

const STORAGE_KEY = "serial-reader-items";
const CROP_SETTINGS_KEY = "serial-reader-crop-settings";

const DEFAULT_CROP = {
  x: 0.2,
  y: 0.5,
  width: 0.65,
  height: 0.085,
  threshold: 120
};

type SerialItem = {
  id: string;
  code: string;
  createdAt: string;
};

function normalize(text: string) {
  return text
    .toUpperCase()
    .replace(/B/g, "8")
    .replace(/S/g, "3")
    .replace(/L/g, "1")
    .replace(/G/g, "6")
    .replace(/[^A-Z0-9]/g, "");
}

function extract11(text: string) {
  const n = normalize(text);

  const results = new Set<string>();

  for (let i = 0; i <= n.length - 11; i++) {
    const chunk = n.slice(i, i + 11);
    if (/^[A-Z0-9]{11}$/.test(chunk)) results.add(chunk);
  }

  return [...results];
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [items, setItems] = useState<SerialItem[]>([]);
  const [raw, setRaw] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selected, setSelected] = useState("");

  const [fixed12, setFixed12] = useState("9");
  const [manual12, setManual12] = useState("");

  const [crop, setCrop] = useState(DEFAULT_CROP);

  const lastChar = "V";

  const twelfth = manual12 || fixed12;

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setItems(JSON.parse(saved));

    const savedCrop = localStorage.getItem(CROP_SETTINGS_KEY);
    if (savedCrop) setCrop(JSON.parse(savedCrop));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  useEffect(() => {
    localStorage.setItem(CROP_SETTINGS_KEY, JSON.stringify(crop));
  }, [crop]);

  async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });

    streamRef.current = stream;

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }

  function capture() {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const cw = vw * crop.width;
    const ch = vh * crop.height;

    const cx = vw * crop.x;
    const cy = vh * crop.y;

    canvas.width = cw;
    canvas.height = ch;

    const ctx = canvas.getContext("2d")!;

    ctx.drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch);

    const img = ctx.getImageData(0, 0, cw, ch);
    const d = img.data;

    for (let i = 0; i < d.length; i += 4) {
      const avg = (d[i] + d[i + 1] + d[i + 2]) / 3;
      const v = avg > crop.threshold ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }

    ctx.putImageData(img, 0, 0);

    const scale = document.createElement("canvas");
    scale.width = cw * 2;
    scale.height = ch * 2;

    const sctx = scale.getContext("2d")!;
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(canvas, 0, 0, scale.width, scale.height);

    return scale.toDataURL("image/png");
  }

  async function readSerial() {
    const img = capture();

    const Tesseract = await import("tesseract.js");

    const r = await Tesseract.recognize(img, "eng", {
      tessedit_pageseg_mode: "7",
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    });

    const text = r.data.text;

    setRaw(text);

    const found11 = extract11(text);

    const final = found11.map(v => v + twelfth + lastChar);

    setCandidates(final);
    setSelected(final[0] || "");
  }

  function save() {
    if (!selected) return;

    if (items[0]?.code === selected) return;

    setItems([
      {
        id: crypto.randomUUID(),
        code: selected,
        createdAt: new Date().toISOString()
      },
      ...items
    ]);
  }

  return (
    <div className="app-shell">

      <div className="panel">

        <h1>シリアル読み取り</h1>

        <div className="button-row">
          <button onClick={startCamera}>カメラ起動</button>
          <button onClick={readSerial}>読み取る</button>
          <button onClick={stopCamera}>停止</button>
        </div>

        <div className="panel">

          <h3>12文字目</h3>

          <select
            value={fixed12}
            onChange={e => setFixed12(e.target.value)}
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

          <div>13文字目: V (固定)</div>

        </div>

      </div>

      <div className="panel">

        <div className="camera-frame">

          <video ref={videoRef} playsInline autoPlay />

        </div>

        <canvas ref={canvasRef} style={{ display: "none" }} />

        <div>

          <h3>OCR</h3>

          <pre>{raw}</pre>

        </div>

        <div>

          <h3>候補</h3>

          {candidates.map(c => (
            <div key={c}>
              <input
                type="radio"
                checked={selected === c}
                onChange={() => setSelected(c)}
              />
              {c}
            </div>
          ))}

        </div>

        <button onClick={save}>保存</button>

      </div>

      <div className="panel">

        <h3>保存済み</h3>

        {items.map(i => (
          <div key={i.id}>
            {i.code}
          </div>
        ))}

      </div>

    </div>
  );
}
