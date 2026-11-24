import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStore } from './store.js';

const REQUIRED = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
const DELETE_BATCH = 1000; // DeleteObjects takes at most 1000 keys

/** ObjectStore on an S3-compatible bucket, configured from S3_* variables. Throws (naming the variable, never a value) when one is unset. */
export function s3Store(env: Record<string, string | undefined>): ObjectStore {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment variable ${missing.join(', ')} (see .env)`);
  const bucket = env.S3_BUCKET!;
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT!,
    region: env.S3_REGION!,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    async list(prefix) {
      const out: { key: string; lastModified: Date }[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of page.Contents ?? []) {
          if (o.Key && o.LastModified) out.push({ key: o.Key, lastModified: o.LastModified });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!r.Body) throw new Error(`s3: ${key} has no body`);
      const body = await r.Body.transformToByteArray();
      return r.ContentEncoding === 'br' ? { body, contentEncoding: 'br' } : { body };
    },
    async put(key, body, meta) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: meta.contentType,
          ContentEncoding: meta.contentEncoding,
          CacheControl: meta.cacheControl,
        }),
      );
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const r = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.slice(i, i + DELETE_BATCH).map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if (r.Errors && r.Errors.length > 0) {
          const e = r.Errors[0]!;
          throw new Error(`s3: ${r.Errors.length} deletes failed, first ${e.Key}: ${e.Code} ${e.Message}`);
        }
      }
    },
  };
}
