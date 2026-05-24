export type SerialItem = {
  id: string;
  code: string;
  createdAt: string;
  copiedAt?: string;
};

export type OcrStatus = "idle" | "starting" | "ready" | "reading" | "error";

export type CropSettings = {
  x: number;
  y: number;
  width: number;
  height: number;
  threshold: number;
};
