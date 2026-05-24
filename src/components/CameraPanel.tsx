import React from "react";

type Props = {
  videoRef: React.Ref<HTMLVideoElement>;
  canvasRef: React.Ref<HTMLCanvasElement>;
  guideStyle: React.CSSProperties;
  rawText: string;
  lastSnapshot: string;
};

export function CameraPanel({
  videoRef,
  canvasRef,
  guideStyle,
  rawText,
  lastSnapshot,
}: Props) {
  return (
    <div className="panel">
      <div className="camera-frame">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="camera-video"
        />

        <div className="camera-overlay">
          <div className="camera-dim" />
          <div className="guide-box-manual" style={guideStyle} />
          <div className="guide-label-manual">
            この枠にコード文字列を合わせる
          </div>
        </div>
      </div>

      <canvas ref={canvasRef} className="hidden-canvas" />

      <div className="preview-grid">
        <div>
          <h2 className="section-title">OCR生テキスト</h2>
          <div className="preview-box">
            {rawText || "まだ読み取り結果はありません"}
          </div>
        </div>

        <div>
          <h2 className="section-title">切り出し画像</h2>
          <div className="preview-box image-box">
            {lastSnapshot ? (
              <img
                src={lastSnapshot}
                alt="snapshot"
                className="snapshot-image"
              />
            ) : (
              <span className="muted">まだ画像はありません</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
