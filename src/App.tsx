import { useEffect, useMemo, useRef, useState } from 'react';

type SerialItem = {
  id: string;
  code: string;
  createdAt: string;
  copiedAt?: string;
};

type OcrStatus = 'idle' | 'starting' | 'ready' | 'reading' | 'error';

const STORAGE_KEY = 'serial-reader-items';
const SERIAL_REGEX = /[A-Z0-9]{13}/g;

function normalizeText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[Ｏ]/g, '0')
    .replace(/[ＩＬ]/g, '1')
    .replace(/[Ｂ]/g, '8')
    .replace(/[\s\-—_]/g, '')
    .replace(/[^A-Z0-9]/g, ' ');
}

function extractSerialCandidates(text: string): string[] {
  const normalized = normalizeText(text);
  const set = new Set<string>();

  const direct = normalized.match(SERIAL_REGEX) ?? [];
  direct.forEach((value) => set.add(value));

  const compact = normalized.replace(/\s+/g, '');
  for (let i = 0; i <= compact.length - 13; i += 1) {
    const chunk = compact.slice(i, i + 13);
    if (/^[A-Z0-9]{13}$/.test(chunk)) {
      set.add(chunk);
    }
  }

  return [...set];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP');
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<OcrStatus>('idle');
  const [statusText, setStatusText] = useState('未起動');
  const [rawText, setRawText] = useState('');
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState('');
  const [items, setItems] = useState<SerialItem[]>([]);
  const [copiedMessage, setCopiedMessage] = useState('');
  const [lastSnapshot, setLastSnapshot] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setItems(JSON.parse(saved) as SerialItem[]);
      } catch {
        // ignore invalid data
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
    if (!copiedMessage) return;
    const timer = window.setTimeout(() => setCopiedMessage(''), 1800);
    return () => window.clearTimeout(timer);
  }, [copiedMessage]);

  const duplicateSet = useMemo(() => {
    const countMap = new Map<string, number>();
    for (const item of items) {
      countMap.set(item.code, (countMap.get(item.code) ?? 0) + 1);
    }
    return new Set([...countMap.entries()].filter(([, count]) => count > 1).map(([code]) => code));
  }, [items]);

  async function startCamera() {
    try {
      setStatus('starting');
      setStatusText('カメラ起動中...');
      stopCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        throw new Error('video element not found');
      }

      video.srcObject = stream;
      await video.play();

      setStatus('ready');
      setStatusText('カメラ準備OK');
    } catch (error) {
      console.error(error);
      setStatus('error');
      setStatusText('カメラ起動失敗。HTTPS とカメラ権限を確認してください。');
    }
  }

  function stopCamera() {
    if (!streamRef.current) return;
    for (const track of streamRef.current.getTracks()) {
      track.stop();
    }
    streamRef.current = null;
  }

  function captureGuideArea(): string | null {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      return null;
    }

    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;

    const cropWidth = Math.floor(videoWidth * 0.72);
    const cropHeight = Math.floor(videoHeight * 0.16);
    const cropX = Math.floor((videoWidth - cropWidth) / 2);
    const cropY = Math.floor(videoHeight * 0.74);

    canvas.width = cropWidth;
    canvas.height = cropHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const imageData = ctx.getImageData(0, 0, cropWidth, cropHeight);
    const { data } = imageData;

    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const boosted = avg > 150 ? 255 : 0;
      data[i] = boosted;
      data[i + 1] = boosted;
      data[i + 2] = boosted;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  async function readSerial() {
    try {
      setStatus('reading');
      setStatusText('OCR実行中...');
      setRawText('');
      setCandidates([]);
      setSelectedCandidate('');

      const snapshot = captureGuideArea();
      if (!snapshot) {
        throw new Error('capture failed');
      }
      setLastSnapshot(snapshot);

      const Tesseract = await import('tesseract.js');
      const result = await Tesseract.recognize(snapshot, 'eng', {
        logger(message) {
          if (message.status === 'recognizing text') {
            setStatusText(`OCR実行中... ${Math.round((message.progress ?? 0) * 100)}%`);
          }
        },
      });

      const text = result.data.text ?? '';
      setRawText(text);

      const found = extractSerialCandidates(text);
      setCandidates(found);
      setSelectedCandidate(found[0] ?? '');
      setStatus('ready');
      setStatusText(found.length > 0 ? `候補 ${found.length} 件` : '候補なし。位置を合わせ直してください。');
    } catch (error) {
      console.error(error);
      setStatus('error');
      setStatusText('OCRに失敗しました');
    }
  }

  function addSelected() {
    if (!selectedCandidate) return;
    const nextItem: SerialItem = {
      id: crypto.randomUUID(),
      code: selectedCandidate,
      createdAt: new Date().toISOString(),
    };
    setItems((prev) => [nextItem, ...prev]);
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setItems((prev) =>
        prev.map((item) =>
          item.id === prev.find((entry) => entry.code === code)?.id
            ? { ...item, copiedAt: new Date().toISOString() }
            : item,
        ),
      );
      setCopiedMessage(`${code} をコピーしました`);
    } catch (error) {
      console.error(error);
      setCopiedMessage('コピーに失敗しました');
    }
  }

  async function copyAll() {
    if (items.length === 0) return;
    try {
      await navigator.clipboard.writeText(items.map((item) => item.code).join('\n'));
      setCopiedMessage('全件コピーしました');
    } catch (error) {
      console.error(error);
      setCopiedMessage('一括コピーに失敗しました');
    }
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function clearAll() {
    if (!window.confirm('保存済みコードを全削除しますか？')) return;
    setItems([]);
  }

  return (
    <div className="app-shell">
      <div className="page">
        <section className="card hero-card">
          <h1>シリアル読み取り試作版</h1>
          <p>
            カメラ映像の中央ガイドに「シリアルナンバー」枠を合わせて読み取ります。
          </p>
          <div className="button-row">
            <button className="primary" onClick={startCamera}>カメラ起動</button>
            <button className="accent" onClick={readSerial} disabled={status !== 'ready'}>読み取る</button>
            <button onClick={stopCamera}>カメラ停止</button>
          </div>
          <div className="status-box">状態: {statusText}</div>
        </section>

        <div className="content-grid">
          <section className="card">
            <div className="camera-wrapper">
              <video ref={videoRef} playsInline muted autoPlay className="camera-video" />
              <div className="overlay">
                <div className="guide-label">この枠にシリアル欄を合わせる</div>
                <div className="guide-frame" />
              </div>
            </div>
            <canvas ref={canvasRef} style={{ display: 'none' }} />

            <div className="preview-grid">
              <div>
                <h2>OCR生テキスト</h2>
                <div className="preview-box text-box">{rawText || 'まだ読み取り結果はありません'}</div>
              </div>
              <div>
                <h2>切り出し画像</h2>
                <div className="preview-box image-box">
                  {lastSnapshot ? <img src={lastSnapshot} alt="snapshot" /> : <span>まだ画像はありません</span>}
                </div>
              </div>
            </div>
          </section>

          <div className="side-column">
            <section className="card">
              <h2>候補</h2>
              <div className="candidate-list">
                {candidates.length === 0 ? (
                  <div className="empty-box">読み取り候補はまだありません</div>
                ) : (
                  candidates.map((candidate) => (
                    <label key={candidate} className="candidate-item">
                      <input
                        type="radio"
                        name="candidate"
                        checked={selectedCandidate === candidate}
                        onChange={() => setSelectedCandidate(candidate)}
                      />
                      <span>{candidate}</span>
                    </label>
                  ))
                )}
              </div>
              <button className="success full" onClick={addSelected} disabled={!selectedCandidate}>
                選択中のコードを保存
              </button>
            </section>

            <section className="card">
              <div className="section-header">
                <h2>保存済みコード</h2>
                <div className="button-row small-gap">
                  <button onClick={copyAll}>全件コピー</button>
                  <button className="danger-outline" onClick={clearAll}>全削除</button>
                </div>
              </div>

              {copiedMessage && <div className="notice-box">{copiedMessage}</div>}

              <div className="saved-list">
                {items.length === 0 ? (
                  <div className="empty-box">まだ保存されていません</div>
                ) : (
                  items.map((item) => (
                    <div key={item.id} className="saved-item">
                      <div>
                        <div className="serial-code">{item.code}</div>
                        <div className="subtle-text">登録: {formatDate(item.createdAt)}</div>
                        {item.copiedAt && <div className="subtle-text">コピー: {formatDate(item.copiedAt)}</div>}
                        {duplicateSet.has(item.code) && <div className="warning-text">重複あり</div>}
                      </div>
                      <div className="button-column">
                        <button className="primary" onClick={() => copyCode(item.code)}>コピー</button>
                        <button onClick={() => removeItem(item.id)}>削除</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
