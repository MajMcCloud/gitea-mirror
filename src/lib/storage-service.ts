import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db as defaultDb } from "./db";
import { configs, repositories, storageReleaseAssets, storageSnapshots, storageStates } from "./db/schema";
import { decryptConfigTokens } from "./utils/config-encryption";
import type { Config } from "@/types/config";
import { processInParallel } from "./utils/concurrency";
import { parseInterval } from "./utils/duration-parser";
import { getGiteaRepoOwnerAsync } from "./gitea";
import {
  newStorageId,
  scanGiteaRepositoryStorage,
  type FetchLike,
  type RepoStorageMeasure,
  type StorageCollectionStatus,
} from "./storage-analytics";

// Destination instances we can measure: the Gitea-compatible REST API is
// required. GitHub/GitLab mirrors are skipped with a clear status message.
const SUPPORTED_DESTINATION_PROVIDERS = new Set(["gitea", "forgejo"]);

type StorageDb = typeof defaultDb;

export interface ResolvedStorageTarget {
  baseUrl: string;
  token: string;
  fullName: string;
}

export interface StorageScanFailure {
  repositoryId: string;
  repositoryName: string;
  reason: string;
}

interface RepoScanOutcome {
  status: "complete" | "partial" | "error" | "skipped";
  measure?: RepoStorageMeasure;
  reason?: string;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

// Resolve where a repository lives on the destination instance and which
// token can read it. Mirrors the logic used by /api/repositories/[id]/releases.
export async function resolveStorageTarget(input: {
  repository: typeof repositories.$inferSelect;
  config: typeof configs.$inferSelect;
}): Promise<ResolvedStorageTarget | { error: string }> {
  const { repository, config } = input;
  const giteaConfig = decryptConfigTokens(config as unknown as Config).giteaConfig;

  const provider = repository.destinationProvider || giteaConfig?.provider || "gitea";
  if (!SUPPORTED_DESTINATION_PROVIDERS.has(provider)) {
    return { error: `Destination provider "${provider}" does not expose the Gitea storage API` };
  }

  const baseUrlRaw = repository.destinationUrl || giteaConfig?.url;
  if (!baseUrlRaw) {
    return { error: "No Gitea destination URL configured" };
  }

  const token = giteaConfig?.token;
  if (!token) {
    return { error: "No Gitea token configured" };
  }

  let fullName = repository.mirroredLocation?.trim();
  if (!fullName || !fullName.includes("/")) {
    const owner =
      (await getGiteaRepoOwnerAsync({ config: config as unknown as Config, repository: repository as never })) ||
      giteaConfig?.defaultOwner ||
      null;
    if (!owner) {
      return { error: "Unable to resolve destination owner for repository" };
    }
    fullName = `${owner}/${repository.name}`;
  }

  return { baseUrl: normalizeBaseUrl(baseUrlRaw), token, fullName };
}

// Persist rules (spec: failed/incomplete scans must never masquerade as
// valid zeros):
//  - complete: replace current assets, upsert state, APPEND a snapshot row.
//  - partial:  keep previous numbers/assets, record status + lastError.
//  - error:    same as partial, only status/last error/scan time move.
//  - skipped:  record the reason without touching any size data.
export async function persistRepositoryStorage(
  database: StorageDb,
  input: {
    userId: string;
    repositoryId: string;
    configId: string;
    outcome: RepoScanOutcome;
  },
): Promise<void> {
  const { userId, repositoryId, configId, outcome } = input;
  const now = new Date();

  if (outcome.status === "error" || outcome.status === "skipped") {
    const values = {
      userId,
      repositoryId,
      configId,
      collectionStatus: "error" as StorageCollectionStatus,
      lastError: outcome.reason ?? "Scan failed",
      lastScannedAt: now,
      updatedAt: now,
    };
    await database
      .insert(storageStates)
      .values({ id: newStorageId("ss"), ...values })
      .onConflictDoUpdate({
        target: storageStates.repositoryId,
        set: {
          configId: values.configId,
          collectionStatus: values.collectionStatus,
          lastError: values.lastError,
          lastScannedAt: values.lastScannedAt,
          updatedAt: values.updatedAt,
        },
      });
    return;
  }

  const measure = outcome.measure;
  if (!measure) {
    return;
  }

  if (outcome.status === "partial") {
    const values = {
      userId,
      repositoryId,
      configId,
      collectionStatus: "partial" as StorageCollectionStatus,
      lastError: measure.error ?? "Incomplete capture",
      lastScannedAt: now,
      updatedAt: now,
    };
    await database
      .insert(storageStates)
      .values({ id: newStorageId("ss"), ...values })
      .onConflictDoUpdate({
        target: storageStates.repositoryId,
        set: {
          configId: values.configId,
          collectionStatus: values.collectionStatus,
          lastError: values.lastError,
          lastScannedAt: values.lastScannedAt,
          updatedAt: values.updatedAt,
        },
      });
    return;
  }

  // Complete scan: everything in one transaction so the "current" view
  // never shows half-replaced assets.
  await database.transaction(async (tx) => {
    await tx.delete(storageReleaseAssets).where(eq(storageReleaseAssets.repositoryId, repositoryId));

    for (const release of measure.releases) {
      for (const asset of release.assets) {
        await tx.insert(storageReleaseAssets).values({
          id: newStorageId("sa"),
          userId,
          repositoryId,
          releaseId: release.id,
          releaseTag: release.tag,
          releaseName: release.name ?? null,
          releaseDraft: release.draft,
          releasePrerelease: release.prerelease,
          releasePublishedAt: release.publishedAt ?? null,
          releaseHtmlUrl: release.htmlUrl ?? null,
          assetId: asset.id,
          assetUuid: asset.uuid ?? null,
          fileName: asset.name,
          sizeBytes: asset.sizeBytes,
          downloadCount: asset.downloadCount,
          downloadUrl: asset.downloadUrl ?? null,
          assetCreatedAt: asset.createdAt ?? null,
          lastScannedAt: now,
        });
      }
    }

    const stateValues = {
      userId,
      repositoryId,
      configId,
      repositorySizeBytes: measure.repositorySizeBytes,
      releaseSizeBytes: measure.releaseSizeBytes,
      totalSizeBytes: measure.totalSizeBytes,
      releaseCount: measure.releaseCount,
      assetCount: measure.assetCount,
      totalDownloadCount: measure.totalDownloadCount,
      largestAssetSizeBytes: measure.largestAssetSizeBytes,
      collectionStatus: "complete" as StorageCollectionStatus,
      lastError: null,
      lastScannedAt: now,
      updatedAt: now,
    };
    await tx
      .insert(storageStates)
      .values({ id: newStorageId("ss"), ...stateValues })
      .onConflictDoUpdate({
        target: storageStates.repositoryId,
        set: {
          ...stateValues,
          createdAt: sql`${storageStates.createdAt}`,
        },
      });

    // History is append-only: growth queries rely on old rows staying put.
    await tx.insert(storageSnapshots).values({
      id: newStorageId("snap"),
      userId,
      repositoryId,
      configId,
      capturedAt: now,
      repositorySizeBytes: measure.repositorySizeBytes,
      releaseSizeBytes: measure.releaseSizeBytes,
      totalSizeBytes: measure.totalSizeBytes,
      releaseCount: measure.releaseCount,
      assetCount: measure.assetCount,
      totalDownloadCount: measure.totalDownloadCount,
      collectionStatus: "complete",
    });
  });
}

export async function scanAndPersistRepositoryStorage(
  database: StorageDb,
  input: {
    userId: string;
    repository: typeof repositories.$inferSelect;
    config: typeof configs.$inferSelect;
    fetchImpl: FetchLike;
    signal?: AbortSignal;
  },
): Promise<RepoScanOutcome> {
  const { userId, repository, config, fetchImpl, signal } = input;
  const target = await resolveStorageTarget({ repository, config });

  if ("error" in target) {
    const outcome: RepoScanOutcome = { status: "skipped", reason: target.error };
    await persistRepositoryStorage(database, {
      userId,
      repositoryId: repository.id,
      configId: config.id,
      outcome,
    });
    return outcome;
  }

  try {
    const measure = await scanGiteaRepositoryStorage({
      baseUrl: target.baseUrl,
      token: target.token,
      fullName: target.fullName,
      fetchImpl,
      signal,
    });

    const outcome: RepoScanOutcome =
      measure.collectionStatus === "complete"
        ? { status: "complete", measure }
        : { status: "partial", measure, reason: measure.error ?? undefined };

    await persistRepositoryStorage(database, {
      userId,
      repositoryId: repository.id,
      configId: config.id,
      outcome,
    });
    return outcome;
  } catch (error) {
    const outcome: RepoScanOutcome = {
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
    };
    await persistRepositoryStorage(database, {
      userId,
      repositoryId: repository.id,
      configId: config.id,
      outcome,
    });
    return outcome;
  }
}

// ===== Scan orchestration + status =====

export interface StorageScanStatus {
  running: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  repositoriesScanned: number;
  repositoriesFailed: number;
  repositoriesSkipped: number;
  error: string | null;
  failures: StorageScanFailure[];
}

const scanStatusByUser = new Map<string, StorageScanStatus>();
const activeScans = new Set<string>();

function createStatus(): StorageScanStatus {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    repositoriesScanned: 0,
    repositoriesFailed: 0,
    repositoriesSkipped: 0,
    error: null,
    failures: [],
  };
}

export function getStorageScanStatus(userId: string): StorageScanStatus {
  return scanStatusByUser.get(userId) ?? createStatus();
}

export function isStorageScanActive(userId: string): boolean {
  return activeScans.has(userId);
}

// One scan pass for a user. Optional configId restricts to one instance,
// optional repositoryIds restricts to specific repositories.
export async function runStorageScan(
  userId: string,
  options: {
    configId?: string;
    repositoryIds?: string[];
    fetchImpl?: FetchLike;
    database?: StorageDb;
    maxParallel?: number;
  } = {},
): Promise<StorageScanStatus> {
  if (activeScans.has(userId)) {
    return getStorageScanStatus(userId);
  }
  activeScans.add(userId);

  const database = options.database ?? defaultDb;
  const fetchImpl = options.fetchImpl ?? fetch;
  const status = createStatus();
  status.running = true;
  status.startedAt = new Date();
  scanStatusByUser.set(userId, status);

  try {
    let userConfigs = database
      .select()
      .from(configs)
      .where(and(eq(configs.userId, userId), eq(configs.isActive, true)))
      .all();

    if (options.configId) {
      userConfigs = userConfigs.filter((config) => config.id === options.configId);
    }

    if (userConfigs.length === 0) {
      status.error = "No active configuration found";
      return status;
    }

    let repos = database
      .select()
      .from(repositories)
      .where(and(eq(repositories.userId, userId), sql`${repositories.status} != 'archived'`))
      .all();

    if (options.repositoryIds && options.repositoryIds.length > 0) {
      const allowed = new Set(options.repositoryIds);
      repos = repos.filter((repo) => allowed.has(repo.id));
    }

    const configById = new Map(userConfigs.map((config) => [config.id, config]));
    const scannable = repos.filter((repo) => repo.configId && configById.has(repo.configId));

    const results = await processInParallel(
      scannable,
      async (repo) => {
        const config = configById.get(repo.configId!)!;
        return scanAndPersistRepositoryStorage(database, {
          userId,
          repository: repo,
          config,
          fetchImpl,
        });
      },
      options.maxParallel ?? 3,
    );

    for (const result of results) {
      if (result.status === "complete") {
        status.repositoriesScanned += 1;
      } else if (result.status === "partial") {
        status.repositoriesScanned += 1;
        status.repositoriesFailed += 1;
      } else if (result.status === "skipped") {
        status.repositoriesSkipped += 1;
      } else {
        status.repositoriesFailed += 1;
      }
    }

    // Details per repository live in storage_states.last_error; the status
    // payload only carries a short overview list.
    status.failures = scannable
      .map((repo, index) => ({ repo, result: results[index] }))
      .filter((entry) => entry.result && entry.result.status !== "complete" && entry.result.status !== "partial")
      .map((entry) => ({
        repositoryId: entry.repo.id,
        repositoryName: entry.repo.fullName || entry.repo.name,
        reason: entry.result?.reason ?? "scan failed",
      }))
      .slice(0, 20);
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  } finally {
    status.running = false;
    status.finishedAt = new Date();
    activeScans.delete(userId);
  }

  return status;
}

// ===== Periodic background service =====

const DEFAULT_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // check every 6h
const DEFAULT_MAX_SCAN_AGE_MS = 24 * 60 * 60 * 1000; // rescan daily
const STARTUP_DELAY_MS = 90 * 1000;
const MAX_PARALLELISM = 3;

let interval: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

export interface StorageScanServiceConfig {
  scanIntervalMs?: number;
  maxScanAgeMs?: number;
}

function getUsersNeedingScan(database: StorageDb, maxAgeMs: number): string[] {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const rows = database
    .select({ userId: repositories.userId })
    .from(repositories)
    .leftJoin(storageStates, eq(storageStates.repositoryId, repositories.id))
    .where(
      and(
        sql`${repositories.status} != 'archived'`,
        sql`${storageStates.id} IS NULL OR ${storageStates.lastScannedAt} < ${Math.floor(cutoff.getTime() / 1000)}`,
      ),
    )
    .groupBy(repositories.userId)
    .all();
  return rows.map((row) => row.userId).filter((userId): userId is string => Boolean(userId));
}

async function runPeriodicScan(database: StorageDb, maxAgeMs: number, fetchImpl: FetchLike): Promise<void> {
  if (shuttingDown) {
    return;
  }
  const userIds = getUsersNeedingScan(database, maxAgeMs);
  for (const userId of userIds) {
    if (shuttingDown) {
      return;
    }
    if (activeScans.has(userId)) {
      continue;
    }
    try {
      await runStorageScan(userId, { database, fetchImpl, maxParallel: MAX_PARALLELISM });
    } catch (error) {
      console.error(
        "[StorageScanService] Scheduled scan failed for user",
        userId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export function startStorageScanService(
  database: StorageDb = defaultDb,
  config: StorageScanServiceConfig = {},
  fetchImpl: FetchLike = fetch,
): void {
  if (interval) {
    return;
  }

  if (process.env.STORAGE_SCAN_ENABLED !== undefined && process.env.STORAGE_SCAN_ENABLED !== "true") {
    console.log("[StorageScanService] Disabled via STORAGE_SCAN_ENABLED");
    return;
  }

  shuttingDown = false;
  let envIntervalMs: number | null = null;
  if (process.env.STORAGE_SCAN_INTERVAL) {
    try {
      envIntervalMs = parseInterval(process.env.STORAGE_SCAN_INTERVAL);
    } catch {
      console.warn("[StorageScanService] Invalid STORAGE_SCAN_INTERVAL:", process.env.STORAGE_SCAN_INTERVAL);
    }
  }
  const scanIntervalMs =
    config.scanIntervalMs ??
    (typeof envIntervalMs === "number" && envIntervalMs > 0 ? envIntervalMs : DEFAULT_SCAN_INTERVAL_MS);
  const maxScanAgeMs = config.maxScanAgeMs ?? DEFAULT_MAX_SCAN_AGE_MS;

  startupTimer = setTimeout(() => {
    void runPeriodicScan(database, maxScanAgeMs, fetchImpl);
  }, STARTUP_DELAY_MS);

  interval = setInterval(() => {
    void runPeriodicScan(database, maxScanAgeMs, fetchImpl);
  }, scanIntervalMs);

  console.log("[StorageScanService] Started", { scanIntervalMs, maxScanAgeMs });
}

export function stopStorageScanService(): void {
  shuttingDown = true;
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  console.log("[StorageScanService] Stopped");
}

export function isStorageScanServiceRunning(): boolean {
  return interval !== null;
}
