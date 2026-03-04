import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function sanitizeFilename(name) {
  return String(name || 'file.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
}

class LocalObjectStore {
  constructor(baseDir, baseUrl = '/uploads') {
    this.baseDir = baseDir;
    this.baseUrl = baseUrl;
  }

  async init() {
    await mkdir(this.baseDir, { recursive: true });
  }

  async put({ keyPrefix, originalName, buffer }) {
    const safeOriginal = sanitizeFilename(originalName || 'upload.bin');
    const fileName = `${keyPrefix}_${Date.now()}_${safeOriginal}`;
    const fullPath = path.join(this.baseDir, fileName);
    await writeFile(fullPath, buffer);

    return {
      fileName,
      url: `${this.baseUrl}/${fileName}`,
      sizeBytes: buffer.length
    };
  }

  resolvePath(fileName) {
    return path.join(this.baseDir, path.basename(fileName));
  }
}

export function createObjectStore({ backend, baseDir, baseUrl }) {
  if (backend !== 'local') {
    throw new Error(`Unsupported object store backend: ${backend}`);
  }
  return new LocalObjectStore(baseDir, baseUrl);
}
