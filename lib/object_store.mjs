import { mkdir, writeFile, readFile } from 'node:fs/promises';
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

  async put({ keyPrefix, originalName, buffer, mimeType }) {
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

  async get({ fileName }) {
    const fullPath = path.join(this.baseDir, path.basename(fileName));
    const data = await readFile(fullPath);
    return {
      data,
      contentType: null // Will be inferred by extension in server
    };
  }

  resolvePath(fileName) {
    return path.join(this.baseDir, path.basename(fileName));
  }
}

class S3ObjectStore {
  constructor(config) {
    this.bucket = config.bucket;
    this.region = config.region || 'us-east-1';
    this.baseUrl = config.baseUrl || '/uploads'; // Proxy URL
    this.config = config;
    this.client = null;
    this.commands = null;
  }

  async init() {
    // No-op for S3 usually, or could check bucket existence
  }

  async ensureClient() {
    if (this.client && this.commands) {
      return;
    }
    const mod = await import('@aws-sdk/client-s3');
    this.commands = {
      PutObjectCommand: mod.PutObjectCommand,
      GetObjectCommand: mod.GetObjectCommand
    };
    this.client = new mod.S3Client({
      region: this.region,
      endpoint: this.config.endpoint || undefined,
      forcePathStyle: !!this.config.endpoint,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey
      }
    });
  }

  async put({ keyPrefix, originalName, buffer, mimeType }) {
    await this.ensureClient();
    const safeOriginal = sanitizeFilename(originalName || 'upload.bin');
    const fileName = `${keyPrefix}_${Date.now()}_${safeOriginal}`;
    
    await this.client.send(new this.commands.PutObjectCommand({
      Bucket: this.bucket,
      Key: fileName,
      Body: buffer,
      ContentType: mimeType || 'application/octet-stream'
    }));

    return {
      fileName,
      url: `${this.baseUrl}/${fileName}`,
      sizeBytes: buffer.length
    };
  }

  async get({ fileName }) {
    await this.ensureClient();
    const response = await this.client.send(new this.commands.GetObjectCommand({
      Bucket: this.bucket,
      Key: fileName
    }));

    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);

    return {
      data,
      contentType: response.ContentType
    };
  }

  resolvePath(fileName) {
    // In S3 mode, we don't have a local path. 
    // This is for backward compatibility if still used, but should be avoided.
    return null;
  }
}

export function createObjectStore({ backend, config, baseDir, baseUrl }) {
  if (backend === 's3') {
    return new S3ObjectStore(config);
  }
  if (backend === 'local') {
    return new LocalObjectStore(baseDir, baseUrl);
  }
  throw new Error(`Unsupported object store backend: ${backend}`);
}
