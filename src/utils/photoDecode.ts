/**
 * 写真ファイルの読み込みと、表示用の画像化（ブラウザの canvas を使う部分）。
 */
import { grayToRgba, rgbaToGray } from "./image";
import type { GrayImage } from "./image";

/**
 * 読み込む写真の長辺の上限（画素）。12M 画素の iPhone 写真（4032×3024）はそのまま。
 * iPhone 15 以降の 24M・48M 画素の写真は、Safari の canvas の上限
 * （約 1,670 万画素）を超えるため、この大きさまで縮小して読む。
 */
const MAX_PHOTO_DIM = 4032;
const MAX_PHOTO_PIXELS = 16_000_000;

/** 写真の向き（EXIF）を反映して読み込む */
async function decodeImage(file: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // 古い Safari など、オプション付きで失敗する場合は <img> で読む
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** 写真ファイルをグレースケールにして返す（必要なら縮小） */
export async function loadPhotoGray(file: Blob): Promise<GrayImage> {
  const decoded = await decodeImage(file);
  try {
    const { width, height } = decoded;
    if (!width || !height) throw new Error("画像の大きさを読み取れませんでした");
    const scale = Math.min(
      1,
      MAX_PHOTO_DIM / Math.max(width, height),
      Math.sqrt(MAX_PHOTO_PIXELS / (width * height))
    );
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("画像を処理できませんでした（canvas）");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    // 大きな canvas のメモリをすぐ手放す
    canvas.width = 1;
    canvas.height = 1;
    return rgbaToGray(rgba, w, h);
  } finally {
    decoded.close();
  }
}

/** グレースケール画像を、表示用の data URL にする */
export function grayToDataUrl(img: GrayImage, type = "image/png"): string {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const imageData = ctx.createImageData(img.width, img.height);
  grayToRgba(img, imageData.data);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL(type, 0.85);
}
