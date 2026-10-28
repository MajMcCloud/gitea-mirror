import type { APIRoute } from "astro";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, configs, repositories, storageReleaseAssets, storageSnapshots, storageStates } from "@/lib/db";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { aggregateSnapshotsByDay, computeGrowth } from "@/lib/storage-analytics";
import { getStorageScanStatus } from "@/lib/storage-service";
import type {
  StorageGrowth,
  StorageInstanceInfo,
  StorageLargestAsset,
  StorageOverviewResponse,
  StorageTopRepository,
  StorageTotals,
} from "@/types/storage";

const TOP_LIMIT = 50;
const ASSET_LIMIT = 20;

const RANGE_DAYS: Record<string, number> = {
  "7": 7,
  "30": 30,
  "90": 90,
  "180": 180,
  "365": 365,
};

/**
 * Dashboard aggregates for the Storage Analytics page.
 *
 * Only rows with collection_status = "complete" feed the sums, so a failed
 * or partial scan can never show up as reduced (fake) storage numbers.
 *
 * GET /api/storage/overview?configId=&range=30
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const params = new URL(request.url).searchParams;
    const configId = params.get("configId") || null;
    const rangeRaw = params.get("range") || "30";
    const rangeDays = RANGE_DAYS[rangeRaw] ?? null;
    // The UI asks for a wider asset list so the low-usage filters can run
    // against the globally largest files.
    const assetLimit = Math.min(Math.max(Number(params.get("assets")) || ASSET_LIMIT, 1), 200);

    const completeOnly = and(
      eq(storageStates.userId, userId),
      eq(storageStates.collectionStatus, "complete"),
      ...(configId ? [eq(storageStates.configId, configId)] : []),
    );

    const userConfigs = db
      .select({ id: configs.id, giteaConfig: configs.giteaConfig })
      .from(configs)
      .where(eq(configs.userId, userId))
      .all();
    const instanceUrlById = new Map<string, string>(
      userConfigs.map((c) => [c.id, String((c.giteaConfig as Record<string, unknown> | null)?.url ?? "")]),
    );
    const providerById = new Map<string, string>(
      userConfigs.map((c) => [c.id, String((c.giteaConfig as Record<string, unknown> | null)?.provider ?? "gitea")]),
    );

    const [totalsRow] = db
      .select({
        totalSizeBytes: sql<number>`COALESCE(SUM(${storageStates.totalSizeBytes}), 0)`,
        repositorySizeBytes: sql<number>`COALESCE(SUM(${storageStates.repositorySizeBytes}), 0)`,
        releaseSizeBytes: sql<number>`COALESCE(SUM(${storageStates.releaseSizeBytes}), 0)`,
        repositoryCount: sql<number>`COUNT(*)`,
        releaseCount: sql<number>`COALESCE(SUM(${storageStates.releaseCount}), 0)`,
        assetCount: sql<number>`COALESCE(SUM(${storageStates.assetCount}), 0)`,
        totalDownloadCount: sql<number>`COALESCE(SUM(${storageStates.totalDownloadCount}), 0)`,
      })
      .from(storageStates)
      .where(completeOnly)
      .all();

    const totals: StorageTotals = {
      totalSizeBytes: Number(totalsRow?.totalSizeBytes ?? 0),
      repositorySizeBytes: Number(totalsRow?.repositorySizeBytes ?? 0),
      releaseSizeBytes: Number(totalsRow?.releaseSizeBytes ?? 0),
      repositoryCount: Number(totalsRow?.repositoryCount ?? 0),
      releaseCount: Number(totalsRow?.releaseCount ?? 0),
      assetCount: Number(totalsRow?.assetCount ?? 0),
      totalDownloadCount: Number(totalsRow?.totalDownloadCount ?? 0),
    };

    const perInstanceRows = db
      .select({
        configId: storageStates.configId,
        totalSizeBytes: sql<number>`COALESCE(SUM(${storageStates.totalSizeBytes}), 0)`,
        repositorySizeBytes: sql<number>`COALESCE(SUM(${storageStates.repositorySizeBytes}), 0)`,
        releaseSizeBytes: sql<number>`COALESCE(SUM(${storageStates.releaseSizeBytes}), 0)`,
        repositoryCount: sql<number>`COUNT(*)`,
      })
      .from(storageStates)
      .where(completeOnly)
      .groupBy(storageStates.configId)
      .all();

    const perInstance: StorageInstanceInfo[] = perInstanceRows.map((row) => ({
      configId: row.configId,
      instanceUrl: instanceUrlById.get(row.configId) || "",
      provider: providerById.get(row.configId) || "gitea",
      totalSizeBytes: Number(row.totalSizeBytes),
      repositorySizeBytes: Number(row.repositorySizeBytes),
      releaseSizeBytes: Number(row.releaseSizeBytes),
      repositoryCount: Number(row.repositoryCount),
    }));

    const topRows = db
      .select({
        repositoryId: storageStates.repositoryId,
        name: repositories.name,
        fullName: repositories.fullName,
        mirroredLocation: repositories.mirroredLocation,
        configId: storageStates.configId,
        repositorySizeBytes: storageStates.repositorySizeBytes,
        releaseSizeBytes: storageStates.releaseSizeBytes,
        totalSizeBytes: storageStates.totalSizeBytes,
        releaseCount: storageStates.releaseCount,
        assetCount: storageStates.assetCount,
        lastScannedAt: storageStates.lastScannedAt,
      })
      .from(storageStates)
      .innerJoin(repositories, eq(repositories.id, storageStates.repositoryId))
      .where(completeOnly)
      .orderBy(desc(storageStates.totalSizeBytes))
      .limit(TOP_LIMIT)
      .all();

    const topRepositories: StorageTopRepository[] = topRows.map((row) => ({
      repositoryId: row.repositoryId,
      name: row.name ?? "",
      fullName: row.fullName ?? row.name ?? "",
      mirroredLocation: row.mirroredLocation,
      configId: row.configId,
      instanceUrl: instanceUrlById.get(row.configId) || "",
      repositorySizeBytes: row.repositorySizeBytes,
      releaseSizeBytes: row.releaseSizeBytes,
      totalSizeBytes: row.totalSizeBytes,
      releaseCount: row.releaseCount,
      assetCount: row.assetCount,
      lastScannedAt: row.lastScannedAt.toISOString(),
    }));

    const assetConditions = [
      eq(storageReleaseAssets.userId, userId),
      ...(configId
        ? [
            sql`${storageReleaseAssets.repositoryId} IN (SELECT ${storageStates.repositoryId} FROM ${storageStates} WHERE ${eq(storageStates.configId, configId)})`,
          ]
        : []),
    ];

    const assetRows = db
      .select({
        id: storageReleaseAssets.id,
        repositoryId: storageReleaseAssets.repositoryId,
        releaseId: storageReleaseAssets.releaseId,
        releaseTag: storageReleaseAssets.releaseTag,
        releaseName: storageReleaseAssets.releaseName,
        releaseHtmlUrl: storageReleaseAssets.releaseHtmlUrl,
        fileName: storageReleaseAssets.fileName,
        sizeBytes: storageReleaseAssets.sizeBytes,
        downloadCount: storageReleaseAssets.downloadCount,
        downloadUrl: storageReleaseAssets.downloadUrl,
        assetCreatedAt: storageReleaseAssets.assetCreatedAt,
        releasePublishedAt: storageReleaseAssets.releasePublishedAt,
      })
      .from(storageReleaseAssets)
      .where(and(...assetConditions))
      .orderBy(desc(storageReleaseAssets.sizeBytes))
      .limit(assetLimit)
      .all();

    const repoNameById = new Map(
      assetRows.length > 0
        ? db
            .select({ id: repositories.id, fullName: repositories.fullName, name: repositories.name })
            .from(repositories)
            .where(eq(repositories.userId, userId))
            .all()
            .map((repo) => [repo.id, repo.fullName || repo.name || ""])
        : [],
    );

    const largestAssets: StorageLargestAsset[] = assetRows.map((row) => ({
      id: row.id,
      repositoryId: row.repositoryId,
      repositoryName: repoNameById.get(row.repositoryId) ?? "",
      releaseId: row.releaseId,
      releaseTag: row.releaseTag,
      releaseName: row.releaseName,
      releaseHtmlUrl: row.releaseHtmlUrl,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      downloadCount: row.downloadCount,
      downloadUrl: row.downloadUrl,
      assetCreatedAt: row.assetCreatedAt?.toISOString() ?? null,
      releasePublishedAt: row.releasePublishedAt?.toISOString() ?? null,
    }));

    // Growth over the selected window from the append-only snapshots.
    let growth: StorageGrowth | null = null;
    const snapshotConditions = [
      eq(storageSnapshots.userId, userId),
      eq(storageSnapshots.collectionStatus, "complete"),
      ...(configId ? [eq(storageSnapshots.configId, configId)] : []),
      ...(rangeDays
        ? [sql`${storageSnapshots.capturedAt} >= ${Math.floor((Date.now() - rangeDays * 86_400_000) / 1000)}`]
        : []),
    ];
    const snapshotRows = db
      .select({
        capturedAt: storageSnapshots.capturedAt,
        repositorySizeBytes: storageSnapshots.repositorySizeBytes,
        releaseSizeBytes: storageSnapshots.releaseSizeBytes,
        totalSizeBytes: storageSnapshots.totalSizeBytes,
      })
      .from(storageSnapshots)
      .where(and(...snapshotConditions))
      .all();

    const series = aggregateSnapshotsByDay(
      snapshotRows.map((row) => ({
        capturedAt: row.capturedAt,
        repositorySizeBytes: row.repositorySizeBytes,
        releaseSizeBytes: row.releaseSizeBytes,
        totalSizeBytes: row.totalSizeBytes,
      })),
    );
    if (series.length >= 2) {
      const g = computeGrowth(
        { totalSizeBytes: series[series.length - 1].totalSizeBytes, capturedAt: series[series.length - 1].capturedAt },
        { totalSizeBytes: series[0].totalSizeBytes, capturedAt: series[0].capturedAt },
      );
      growth = {
        currentTotalBytes: g.current,
        previousTotalBytes: g.previous,
        deltaBytes: g.deltaBytes,
        deltaPercent: g.deltaPercent,
        days: g.days,
        avgBytesPerDay: g.avgBytesPerDay,
        rangeDays,
      };
    }

    const [scanRow] = db
      .select({
        complete: sql<number>`COALESCE(SUM(CASE WHEN ${storageStates.collectionStatus} = 'complete' THEN 1 ELSE 0 END), 0)`,
        partial: sql<number>`COALESCE(SUM(CASE WHEN ${storageStates.collectionStatus} = 'partial' THEN 1 ELSE 0 END), 0)`,
        error: sql<number>`COALESCE(SUM(CASE WHEN ${storageStates.collectionStatus} = 'error' THEN 1 ELSE 0 END), 0)`,
        lastScannedAt: sql<number | null>`MAX(${storageStates.lastScannedAt})`,
      })
      .from(storageStates)
      .where(
        and(eq(storageStates.userId, userId), ...(configId ? [eq(storageStates.configId, configId)] : [])),
      )
      .all();

    const lastErrorRow = db
      .select({ lastError: storageStates.lastError })
      .from(storageStates)
      .where(
        and(
          eq(storageStates.userId, userId),
          sql`${storageStates.collectionStatus} != 'complete'`,
          sql`${storageStates.lastError} IS NOT NULL`,
          ...(configId ? [eq(storageStates.configId, configId)] : []),
        ),
      )
      .orderBy(desc(storageStates.lastScannedAt))
      .limit(1)
      .all();

    const scanStatus = getStorageScanStatus(userId);

    const data: StorageOverviewResponse = {
      totals,
      perInstance,
      topRepositories,
      largestAssets,
      growth,
      scan: {
        complete: Number(scanRow?.complete ?? 0),
        partial: Number(scanRow?.partial ?? 0),
        error: Number(scanRow?.error ?? 0),
        lastScannedAt:
          scanRow?.lastScannedAt !== null && scanRow?.lastScannedAt !== undefined
            ? new Date(Number(scanRow.lastScannedAt) * 1000).toISOString()
            : null,
        lastError: lastErrorRow[0]?.lastError ?? null,
      },
      scanStatus: scanStatus.startedAt || scanStatus.running
        ? {
            ...scanStatus,
            startedAt: scanStatus.startedAt?.toISOString() ?? null,
            finishedAt: scanStatus.finishedAt?.toISOString() ?? null,
          }
        : null,
    };

    return jsonResponse({ data, status: 200 });
  } catch (error) {
    return createSecureErrorResponse(error, "storage overview", 500);
  }
};
