import { mkdir, readFile, readdir, stat, unlink, writeAtomic } from "@toonflow/file";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

// ACT: 画布/缩略图预览变体。原图永不修改，失败一律回退原文件，不影响下载、导出与生成链路。

const PREVIEW_VERSION = "v1";
const PREVIEW_QUALITY = 82;
const MAX_CONCURRENT = 2;
const GENERATE_TIMEOUT_MS = 15_000;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 100_000_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = Number(process.env.TOONFLOW_PREVIEW_CACHE_BYTES ?? 2 * 1024 * 1024 * 1024);
const PREVIEW_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

export type ImagePreview = { data: Uint8Array; etag: string };

export function isImagePreviewEnabled() {
  return process.env.TOONFLOW_PREVIEW !== "0";
}

export function canPreviewImage(path: string) {
  const extension = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return PREVIEW_EXTENSIONS.has(extension);
}

let running = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<() => void> {
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running = Math.max(0, running - 1);
      waiters.shift()?.();
    };
  };
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve(makeRelease());
  }
  return new Promise(resolve => waiters.push(() => {
    running++;
    resolve(makeRelease());
  }));
}

const inflight = new Map<string, Promise<ImagePreview | undefined>>();

function cacheDirectory() {
  const base = process.env.TOONFLOW_DATA_DIR ?? join(process.cwd(), "data");
  return join(base, "cache", "previews");
}

function previewKey(filePath: string, mtimeMs: number, size: number, maxEdge: number) {
  return createHash("sha256").update(`${filePath}|${mtimeMs}|${size}|${maxEdge}|${PREVIEW_VERSION}`).digest("hex");
}

function previewEtag(key: string) {
  return `W/"${key.slice(0, 24)}"`;
}

async function isSkipped(cachePath: string) {
  try {
    await stat(`${cachePath}.skip`);
    return true;
  } catch {
    return false;
  }
}

async function markSkipped(cachePath: string) {
  // ACT: 明确不适合预览的图（超大/无压缩收益）落一个空标记，避免每次请求重复读大文件。
  await writeAtomic(`${cachePath}.skip`, new Uint8Array(0), { mode: 0o600 }).catch(() => {});
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("图片预览生成超时")), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

async function generatePreview(sourcePath: string, cachePath: string, key: string, maxEdge: number): Promise<ImagePreview | undefined> {
  const source = await readFile(sourcePath);
  if (source.length > MAX_SOURCE_BYTES) return undefined;
  const metadata = await new Bun.Image(source).metadata();
  if (!metadata.width || !metadata.height) return undefined;
  if (metadata.width * metadata.height > MAX_SOURCE_PIXELS) return undefined;
  const scale = Math.min(1, maxEdge / Math.max(metadata.width, metadata.height));
  const width = Math.max(1, Math.round(metadata.width * scale));
  const height = Math.max(1, Math.round(metadata.height * scale));
  const image = new Bun.Image(source).resize(width, height, { fit: "fill" });
  image.webp({ quality: PREVIEW_QUALITY });
  const output = new Uint8Array(await image.buffer());
  // ACT: 未缩小且转码反而更大时保留原图，避免预览比原图还占带宽。
  if (scale === 1 && output.length >= source.length) return undefined;
  await mkdir(dirname(cachePath), { recursive: true });
  await writeAtomic(cachePath, output, { mode: 0o600 });
  return { data: output, etag: previewEtag(key) };
}

let lastCleanup = 0;

async function cleanupPreviews() {
  const directory = cacheDirectory();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
  const now = Date.now();
  const items: { path: string; size: number; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".webp") && !name.endsWith(".skip")) continue;
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > CACHE_MAX_AGE_MS) {
        await unlink(path);
        continue;
      }
      items.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // ACT: 并发删除/读取产生的瞬时错误忽略，下一轮清理再处理。
    }
  }
  let total = items.reduce((sum, item) => sum + item.size, 0);
  if (total <= CACHE_MAX_BYTES) return;
  items.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const item of items) {
    if (total <= CACHE_MAX_BYTES) break;
    try {
      await unlink(item.path);
      total -= item.size;
    } catch {
      // 同上，忽略瞬时错误。
    }
  }
}

function maybeCleanupPreviews() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  void cleanupPreviews().catch(error => console.warn("图片预览缓存清理失败", error));
}

/**
 * 读取或生成图片预览（WebP，长边不超过 maxEdge）。
 * 返回 undefined 表示应回退原文件（非图片、超限、转码失败或压缩无收益）。
 */
export async function getImagePreview(sourcePath: string, file: { size: number; mtimeMs: number }, maxEdge: number): Promise<ImagePreview | undefined> {
  if (!canPreviewImage(sourcePath)) return undefined;
  maybeCleanupPreviews();
  const key = previewKey(sourcePath, file.mtimeMs, file.size, maxEdge);
  const cachePath = join(cacheDirectory(), `${key}.webp`);
  try {
    const cached = await readFile(cachePath);
    if (cached.length) return { data: cached, etag: previewEtag(key) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  if (file.size > MAX_SOURCE_BYTES || await isSkipped(cachePath)) {
    await markSkipped(cachePath);
    return undefined;
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = (async () => {
    const release = await acquireSlot();
    try {
      const result = await withTimeout(generatePreview(sourcePath, cachePath, key, maxEdge), GENERATE_TIMEOUT_MS);
      if (!result) await markSkipped(cachePath);
      return result;
    } finally {
      release();
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}
