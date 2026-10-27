export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validateImageFile(file) {
  if (!file || (file.size === 0 && !file.name)) return { valid: true, error: null };
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    return { valid: false, error: 'Unsupported image type. Choose a JPEG, PNG, or WebP image.' };
  }
  if (file.size <= 0) return { valid: false, error: 'The selected image is empty. Choose another image.' };
  if (file.size > MAX_IMAGE_BYTES) {
    return { valid: false, error: 'Image is too large. Choose an image that is 3 MiB or smaller.' };
  }
  return { valid: true, error: null };
}

export function readImageFile(file, Reader = globalThis.FileReader) {
  return new Promise((resolve, reject) => {
    if (typeof Reader !== 'function') {
      reject(new Error('Image reading is unavailable in this browser.'));
      return;
    }
    let reader;
    try {
      reader = new Reader();
      reader.onload = () => {
        if (typeof reader.result !== 'string' || !reader.result.startsWith('data:image/')) {
          reject(new Error('The selected image could not be read. Choose another image.'));
          return;
        }
        resolve(reader.result);
      };
      reader.onerror = () => reject(reader.error || new Error('The selected image could not be read.'));
      reader.onabort = () => reject(new Error('Image reading was interrupted. Choose the image again.'));
      reader.readAsDataURL(file);
    } catch (error) {
      reject(error);
    }
  });
}

export async function saveReportBundle(entries, persist) {
  try {
    await persist(entries);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
export function verifyImageDataUrl(dataUrl, ImageCtor = globalThis.Image) {
  return new Promise((resolve, reject) => {
    if (typeof ImageCtor !== 'function') { reject(new Error('Image preview is unavailable in this browser.')); return; }
    const image = new ImageCtor();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve(true);
      else reject(new Error('The selected image is not a readable image.'));
    };
    image.onerror = () => reject(new Error('The selected image is not a readable image.'));
    try { image.src = dataUrl; } catch (error) { reject(error); }
  });
}
