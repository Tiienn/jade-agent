// Shared interfaces used across the edge functions.

import type { Category } from "./parser.ts";

export type { Category };
export type PreviewType = "pdf" | "image" | "dwg" | "other";

/** A file or folder returned to the frontend (never contains SharePoint URLs). */
export interface FileResult {
  id: string;
  driveId: string;
  name: string;
  /** lowercase extension with no dot; "" for folders */
  extension: string;
  /** human-readable path under the drive root */
  path: string;
  size: number;
  lastModified: string | null;
  isFolder: boolean;
  previewType: PreviewType;
  /** Short-lived small-preview image URL (from Graph thumbnails), if available. */
  thumbnailUrl?: string;
}

/** Info needed to stream a file download. */
export interface DownloadInfo {
  name: string;
  size: number;
  downloadUrl: string | null;
  mimeType?: string;
}
