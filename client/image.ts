// Client-side image prep: resize to ≤1600px on the long edge and encode
// WebP (fallback JPEG) so uploads are small and the Worker never spends
// its tiny CPU budget on resizing.

export const IMAGE_MAX_EDGE = 1600;

export interface PreparedImage {
  blob: Blob;
  mime: string; // image/webp | image/jpeg
  width: number;
  height: number;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Could not read that image.');
  }

  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // WebP everywhere modern; JPEG fallback where WebP encoding is unsupported.
  const webp = await toBlob(canvas, 'image/webp', 0.85);
  if (webp && webp.type === 'image/webp') {
    return { blob: webp, mime: 'image/webp', width, height };
  }
  const jpeg = await toBlob(canvas, 'image/jpeg', 0.85);
  if (!jpeg) throw new Error('Could not encode that image.');
  return { blob: jpeg, mime: 'image/jpeg', width, height };
}
