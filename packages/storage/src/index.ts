import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// S3-compatible object storage: SeaweedFS locally, Backblaze B2 in production.

export type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.log': 'text/plain; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

export class Storage {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(cfg: StorageConfig) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(
    key: string,
    body: Buffer | string | Readable,
    contentType?: string,
    cacheControl?: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType ?? contentTypeFor(key),
        ...(cacheControl && { CacheControl: cacheControl }),
      }),
    );
  }

  async getText(key: string): Promise<string | undefined> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return (await r.Body?.transformToString('utf8')) ?? undefined;
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return undefined;
      throw err;
    }
  }

  async getStream(
    key: string,
  ): Promise<
    { body: Readable; contentType: string | undefined; length: number | undefined } | undefined
  > {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { body: r.Body as Readable, contentType: r.ContentType, length: r.ContentLength };
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return undefined;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
        }),
      );
    }
    return keys.length;
  }

  presignGet(key: string, expiresIn = 300): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
  }

  /** Uploads every file under `dir` to `prefix/`, with bounded concurrency. */
  async uploadDir(
    dir: string,
    prefix: string,
    cacheControl: (rel: string) => string | undefined = () => undefined,
    concurrency = 8,
  ): Promise<{ files: number; bytes: number }> {
    const files: string[] = [];
    for await (const f of walk(dir)) files.push(f);
    let bytes = 0;
    let i = 0;
    const worker = async () => {
      while (i < files.length) {
        const f = files[i++];
        if (!f) break;
        const rel = relative(dir, f).split(sep).join('/');
        const size = (await stat(f)).size;
        bytes += size;
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: `${prefix}/${rel}`,
            Body: createReadStream(f),
            ContentLength: size,
            ContentType: contentTypeFor(rel),
            ...(cacheControl(rel) && { CacheControl: cacheControl(rel) }),
          }),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
    return { files: files.length, bytes };
  }
}
