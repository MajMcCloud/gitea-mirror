import crypto from "node:crypto";

// Storage Analytics core logic.
//
// Scope: purely what the Gitea REST API can tell us. Repository "size" is
// reported in KiB (covers Git data plus the LFS data Gitea counts in it) and
// release assets report byte sizes without needing downloads. This is an
// estimate of tracked storage, NOT a physical disk census: actions artifacts,
// packages/registries, avatars, issue attachments, database size and
// filesystem overhead are all invisible to these endpoints.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type StorageCollectionStatus = "complete" | "partial" | "error";

export interface GiteaAssetInfo {
  id: number;
  uuid?: string | null;
  name: string;
  sizeBytes: number;
  downloadCount: number;
  downloadUrl?: string | null;
  createdAt?: Date | null;
}

export interface GiteaReleaseInfo {
  id: number;
  tag: string;
  name?: string | null;
  draft: boolean;
  prerelease: boolean;
  publishedAt?: Date | null;
  htmlUrl?: string | null;
  assets: GiteaAssetInfo[];
}

export interface RepoStorageMeasure {
  repositorySizeBytes: number;
  releaseSizeBytes: number;
  totalSizeBytes: number;
  releaseCount: number;
  assetCount: number;
  totalDownloadCount: number;
  largestAssetSizeBytes: number;
  releases: GiteaReleaseInfo[];
  collectionStatus: StorageCollectionStatus;
  error?: string | null;
  giteaUpdatedAt?: Date | null;
  archived?: boolean;
}

export const KiB = 1024;

// Gitea reports repository size in KiB, already truncated/rounded server-side.
export function kibToBytes(sizeKiB: unknown): number | null {
  if (typeof sizeKiB !== "number" || !Number.isFinite(sizeKiB) || sizeKiB < 0) {
    return null;
  }
  return Math.round(sizeKiB * KiB);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface RetryOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GET with bounded retries. Retries network errors, timeouts, 429 and 5xx.
// Honors Retry-After (seconds or HTTP date) capped to a sane wait.
export async function giteaGetJson(
  url: string,
  token: string,
  fetchImpl: FetchLike,
  options: RetryOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let lastError = "request failed";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller);

    try {
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (response.ok) {
        return await response.json();
      }

      const retryable = response.status === 429 || response.status >= 500;
      lastError = `HTTP ${response.status} ${response.statusText || ""}`.trim();

      if (!retryable || attempt === maxAttempts) {
        throw new Error(`Gitea API request failed: ${lastError}`);
      }

      const retryAfterHeader = response.headers?.get?.("Retry-After") ?? null;
      let waitMs = Math.min(1000 * attempt, MAX_RETRY_AFTER_MS);
      if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds >= 0) {
          waitMs = Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
        } else {
          const date = Date.parse(retryAfterHeader);
          if (!Number.isNaN(date)) {
            waitMs = Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
          }
        }
      }
      await sleep(waitMs);
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      if (error instanceof Error && error.message.startsWith("Gitea API request failed")) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts) {
        break;
      }
      await sleep(Math.min(1000 * attempt, MAX_RETRY_AFTER_MS));
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  throw new Error(`Gitea API request failed: ${lastError}`);
}

export interface ScanGiteaRepoOptions {
  baseUrl: string;
  token: string;
  fullName: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
  perPage?: number;
  maxPages?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

const DEFAULT_PER_PAGE = 50;
// Hard stop so a server that keeps answering with full duplicate pages
// can never spin us into an endless loop.
const DEFAULT_MAX_PAGES = 500;

export interface ScanGiteaRepoResult extends RepoStorageMeasure {
  htmlUrl?: string | null;
}

// Reads ONE repository's storage footprint via two endpoints:
//   GET /repos/{owner}/{repo}                 -> size (KiB)
//   GET /repos/{owner}/{repo}/releases        -> releases + assets (paginated)
// Never downloads assets. A pagination failure marks the scan "partial";
// the caller must not persist partial numbers as a valid snapshot.
export async function scanGiteaRepositoryStorage(
  options: ScanGiteaRepoOptions,
): Promise<ScanGiteaRepoResult> {
  const base = normalizeBaseUrl(options.baseUrl);
  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const fullName = options.fullName.replace(/^\/+|\/+$/g, "");

  const repoJson = (await giteaGetJson(
    `${base}/api/v1/repos/${fullName}`,
    options.token,
    options.fetchImpl,
    { signal: options.signal, timeoutMs: options.timeoutMs, maxAttempts: options.maxAttempts },
  )) as Record<string, unknown>;

  const repositorySizeBytes = kibToBytes(repoJson.size);
  if (repositorySizeBytes === null) {
    return {
      repositorySizeBytes: 0,
      releaseSizeBytes: 0,
      totalSizeBytes: 0,
      releaseCount: 0,
      assetCount: 0,
      totalDownloadCount: 0,
      largestAssetSizeBytes: 0,
      releases: [],
      collectionStatus: "error",
      error: "Repository size missing or invalid in API response",
      giteaUpdatedAt: parseDate(repoJson.updated_at),
      archived: typeof repoJson.archived === "boolean" ? repoJson.archived : undefined,
      htmlUrl: typeof repoJson.html_url === "string" ? repoJson.html_url : null,
    };
  }

  const releases: GiteaReleaseInfo[] = [];
  const seenReleaseIds = new Set<number>();
  let collectionStatus: StorageCollectionStatus = "complete";
  let error: string | null = null;

  for (let page = 1; page <= maxPages; page++) {
    let batch: unknown;
    try {
      batch = await giteaGetJson(
        `${base}/api/v1/repos/${fullName}/releases?per_page=${perPage}&page=${page}`,
        options.token,
        options.fetchImpl,
        { signal: options.signal, timeoutMs: options.timeoutMs, maxAttempts: options.maxAttempts },
      );
    } catch (err) {
      collectionStatus = "partial";
      error = `Release page ${page} failed: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }

    if (!Array.isArray(batch)) {
      collectionStatus = "partial";
      error = `Unexpected releases response (page ${page}): not an array`;
      break;
    }

    for (const item of batch) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const release = item as Record<string, unknown>;
      const releaseId = Number(release.id);
      if (!Number.isInteger(releaseId) || seenReleaseIds.has(releaseId)) {
        // Duplicate pages (shifting pagination) must not double count.
        continue;
      }
      seenReleaseIds.add(releaseId);

      const rawAssets = Array.isArray(release.assets) ? release.assets : [];
      const assets: GiteaAssetInfo[] = [];
      for (const rawAsset of rawAssets) {
        if (!rawAsset || typeof rawAsset !== "object") {
          continue;
        }
        const asset = rawAsset as Record<string, unknown>;
        const assetId = Number(asset.id);
        const sizeBytes = Number(asset.size);
        if (!Number.isInteger(assetId) || sizeBytes === undefined || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
          // A malformed asset entry means the totals cannot be trusted.
          collectionStatus = "partial";
          error = `Invalid asset entry in release ${releaseId}`;
          continue;
        }
        assets.push({
          id: assetId,
          uuid: typeof asset.uuid === "string" ? asset.uuid : null,
          name: typeof asset.name === "string" ? asset.name : String(assetId),
          sizeBytes: Math.round(sizeBytes),
          downloadCount: Number.isFinite(Number(asset.download_count)) ? Math.max(0, Math.round(Number(asset.download_count))) : 0,
          downloadUrl: typeof asset.browser_download_url === "string" ? asset.browser_download_url : null,
          createdAt: parseDate(asset.created_at),
        });
      }

      releases.push({
        id: releaseId,
        tag: typeof release.tag_name === "string" ? release.tag_name : "",
        name: typeof release.name === "string" ? release.name : null,
        draft: release.draft === true,
        prerelease: release.prerelease === true,
        publishedAt: parseDate(release.published_at ?? release.created_at),
        htmlUrl: typeof release.html_url === "string" ? release.html_url : null,
        assets,
      });
    }

    if (collectionStatus === "partial") {
      break;
    }

    if (batch.length < perPage) {
      break;
    }

    if (page === maxPages) {
      collectionStatus = "partial";
      error = `Release pagination exceeded ${maxPages} pages`;
    }
  }

  let releaseSizeBytes = 0;
  let assetCount = 0;
  let totalDownloadCount = 0;
  let largestAssetSizeBytes = 0;
  for (const release of releases) {
    for (const asset of release.assets) {
      releaseSizeBytes += asset.sizeBytes;
      assetCount += 1;
      totalDownloadCount += asset.downloadCount;
      if (asset.sizeBytes > largestAssetSizeBytes) {
        largestAssetSizeBytes = asset.sizeBytes;
      }
    }
  }

  return {
    repositorySizeBytes,
    releaseSizeBytes,
    totalSizeBytes: repositorySizeBytes + releaseSizeBytes,
    releaseCount: releases.length,
    assetCount,
    totalDownloadCount,
    largestAssetSizeBytes,
    releases,
    collectionStatus,
    error,
    giteaUpdatedAt: parseDate(repoJson.updated_at),
    archived: typeof repoJson.archived === "boolean" ? repoJson.archived : undefined,
    htmlUrl: typeof repoJson.html_url === "string" ? repoJson.html_url : null,
  };
}

// ===== Growth / history helpers =====

export interface StorageSnapshotPoint {
  capturedAt: Date;
  repositorySizeBytes: number;
  releaseSizeBytes: number;
  totalSizeBytes: number;
}

export interface GrowthResult {
  current: number;
  previous: number;
  deltaBytes: number;
  deltaPercent: number | null;
  days: number;
  avgBytesPerDay: number | null;
}

export function computeGrowth(
  current: { totalSizeBytes: number; capturedAt: Date },
  previous: { totalSizeBytes: number; capturedAt: Date },
): GrowthResult {
  const deltaBytes = current.totalSizeBytes - previous.totalSizeBytes;
  const deltaPercent =
    previous.totalSizeBytes > 0
      ? (deltaBytes / previous.totalSizeBytes) * 100
      : deltaBytes !== 0
        ? null
        : 0;
  const ms = current.capturedAt.getTime() - previous.capturedAt.getTime();
  const days = ms > 0 ? ms / (24 * 60 * 60 * 1000) : 0;
  return {
    current: current.totalSizeBytes,
    previous: previous.totalSizeBytes,
    deltaBytes,
    deltaPercent,
    days,
    avgBytesPerDay: days > 0 ? deltaBytes / days : null,
  };
}

export interface GrowthProjection {
  days: number;
  projectedBytes: number;
}

export interface ProjectionResult {
  avgBytesPerDay: number;
  observations: number;
  spanDays: number;
  projections: GrowthProjection[];
}

export const MIN_PROJECTION_DAYS = 7;

// Linear projection from the average daily growth across complete snapshots.
// Only shows a projection when the history spans at least MIN_PROJECTION_DAYS
// days; gaps are tolerated because the average is taken over the whole span.
export function projectGrowth(
  points: Array<{ capturedAt: Date; totalSizeBytes: number }>,
  horizons: number[] = [30, 90, 365],
): ProjectionResult | null {
  if (points.length < 2) {
    return null;
  }
  const sorted = [...points].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanDays = (last.capturedAt.getTime() - first.capturedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (spanDays < MIN_PROJECTION_DAYS) {
    return null;
  }
  const avgBytesPerDay = (last.totalSizeBytes - first.totalSizeBytes) / spanDays;
  return {
    avgBytesPerDay,
    observations: sorted.length,
    spanDays,
    projections: horizons
      .filter((days) => days <= spanDays * 4)
      .map((days) => ({
        days,
        projectedBytes: Math.round(last.totalSizeBytes + avgBytesPerDay * days),
      })),
  };
}

// Bucket snapshots by UTC day and keep only days with a complete capture.
// Missing days are left out entirely so the chart can draw them as gaps.
export function aggregateSnapshotsByDay(points: StorageSnapshotPoint[]): StorageSnapshotPoint[] {
  const byDay = new Map<number, { sumRepo: number; sumRelease: number; sumTotal: number; count: number }>();
  for (const point of points) {
    const day = Math.floor(point.capturedAt.getTime() / (24 * 60 * 60 * 1000));
    const entry = byDay.get(day) ?? { sumRepo: 0, sumRelease: 0, sumTotal: 0, count: 0 };
    entry.sumRepo += point.repositorySizeBytes;
    entry.sumRelease += point.releaseSizeBytes;
    entry.sumTotal += point.totalSizeBytes;
    entry.count += 1;
    byDay.set(day, entry);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, entry]) => ({
      capturedAt: new Date(day * 24 * 60 * 60 * 1000),
      repositorySizeBytes: entry.sumRepo,
      releaseSizeBytes: entry.sumRelease,
      totalSizeBytes: entry.sumTotal,
    }));
}

export interface LowUsageFilter {
  minSizeBytes?: number;
  maxDownloads?: number;
  olderThanDays?: number;
  limit?: number;
}

export const DEFAULT_LOW_USAGE_LIMIT = 20;

// Candidate rows for cleanup review only. download_count is per-instance and
// says nothing about downloads of the original or other mirrors.
export function matchesLowUsageFilter(
  asset: { sizeBytes: number; downloadCount: number; releasePublishedAt?: Date | null },
  filter: LowUsageFilter,
  now: Date = new Date(),
): boolean {
  if (filter.minSizeBytes !== undefined && asset.sizeBytes < filter.minSizeBytes) {
    return false;
  }
  if (filter.maxDownloads !== undefined && asset.downloadCount > filter.maxDownloads) {
    return false;
  }
  if (filter.olderThanDays !== undefined) {
    const published = asset.releasePublishedAt;
    if (!published) {
      return false;
    }
    const ageDays = (now.getTime() - published.getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays < filter.olderThanDays) {
      return false;
    }
  }
  return true;
}

export function newStorageId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}
