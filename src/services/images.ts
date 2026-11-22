import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { ServiceUnavailableError, ValidationError } from '../lib/errors.js';

export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
const MAX_BYTES = 5 * 1024 * 1024;

function detectType(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/**
 * Uploads to ImgBB (the API key never leaves the server). In development with no key, falls back to
 * local disk so the app is usable offline; production without a key refuses.
 */
export async function uploadImage(dataUrl: string, fileName = 'upload'): Promise<{ url: string; provider: 'imgbb' | 'local' }> {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw new ValidationError('Only PNG, JPEG, and WEBP image files are supported.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_BYTES) throw new ValidationError('Image exceeds the maximum size of 5 MB.');
  const kind = detectType(buf);
  if (!kind) throw new ValidationError('The uploaded file is not a valid PNG, JPEG, or WEBP image.');

  if (env.IMGBB_API_KEY) {
    const form = new FormData();
    form.append('image', buf.toString('base64'));
    form.append('name', fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60));
    let res: Response;
    try {
      res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(env.IMGBB_API_KEY)}`, { method: 'POST', body: form });
    } catch {
      throw new ServiceUnavailableError('Image hosting is temporarily unreachable. Please try again.');
    }
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.success || !json?.data?.url) {
      throw new ServiceUnavailableError('Image upload failed. Please try a different image or try again later.');
    }
    return { url: json.data.url as string, provider: 'imgbb' };
  }

  if (env.isProduction) throw new ServiceUnavailableError('Image hosting is not configured.');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${kind}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: `/api/uploads/${name}`, provider: 'local' };
}
