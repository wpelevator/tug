import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createClient } from 'redis';
import { db } from './db.js';

const app = express();
const cache = createClient({ url: 'redis://redis:6379' });
cache.on('error', (err) => console.error('Redis:', err.message));
await cache.connect();
const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});
const bucket = process.env.S3_BUCKET;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.get('/health', (_req, res) => res.send('ok'));
app.get('/files', async (_req, res) => {
  let data = await cache.get('files');
  if (!data) {
    data = JSON.stringify((await db.query('SELECT id, name FROM files ORDER BY name')).rows);
    await cache.set('files', data, { EX: 30 });
  }
  res.type('json').send(data);
});
app.post('/files', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('file required');
  const id = randomUUID();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: id,
      Body: req.file.buffer,
      ContentType: 'application/octet-stream',
    }),
  );
  try {
    await db.query('INSERT INTO files VALUES ($1, $2, $3)', [id, req.file.originalname, id]);
  } catch (err) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: id }));
    throw err;
  }
  await cache.del('files');
  res.status(201).json({ id, name: req.file.originalname });
});
app.get('/files/:id', async (req, res) => {
  const result = await db.query('SELECT object_key FROM files WHERE id::text = $1', [
    req.params.id,
  ]);
  if (!result.rowCount) return res.sendStatus(404);
  const object = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: result.rows[0].object_key }),
  );
  res.type('application/octet-stream');
  object.Body.pipe(res);
});
app.listen(3000, '0.0.0.0');
