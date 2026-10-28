import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { db, configs, repositories, storageReleaseAssets, storageSnapshots, storageStates } from "@/lib/db";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import {
  aggregateSnapshotsByDay,
  computeGrowth,
  projectGrowth,
} from "@/lib/storage-analytics";
import type {
  StorageAssetRow,
  StorageGrowth,
  StorageHistoryPoint,
  StorageProjection,
  StorageReleaseRow,
  StorageRepositoryDetailResponse,
} from "@/types/storage";

/**
 * Storage drill-down for a single repository: current numbers, its releases,
 * all assets and the snapshot history.
 *
 * GET /api/storage/repository/:id
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const repoId = params.id;
    if (!repoId) {
      return jsonResponse({ data: { success: false, error: "Repository ID is required" }, status: 400 });
    }

    const [repo] = db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, repoId), eq(repositories.userId, userId)))
      .limit(1)
      .all();
    if (!repo) {
      return jsonResponse({ data: { success: false, error: "Repository not found" }, status: 404 });
    }

    const [state] = db
      .select()
      .from(storageStates)
      .where(eq(storageStates.repositoryId, repoId))
      .limit(1)
      .all();

    const configId = state?.configId ?? repo.configId ?? "";
    const [config] = configId
      ? db
          .select({ giteaConfig: configs.giteaConfig })
          .from(configs)
          .where(eq(configs.id, configId))
          .limit(1)
          .all()
      : [];
    const gitea = (config?.giteaConfig ?? null) as Record<string, unknown> | null;
    const instanceUrl = String(gitea?.url ?? repo.destinationUrl ?? "");
    const provider = String(repo.destinationProvider || gitea?.provider || "gitea");
    const location = repo.mirroredLocation || "";
    const htmlUrl = instanceUrl && location
      ? `${instanceUrl.replace(/\/+$/, "")}/${location}`
      : null;

    const assetRows = db
      .select()
      .from(storageReleaseAssets)
      .where(eq(storageReleaseAssets.repositoryId, repoId))
      .all();

    const releasesById = new Map<number, StorageReleaseRow>();
    const assets: StorageAssetRow[] = [];
    for (const row of assetRows) {
      let release = releasesById.get(row.releaseId);
      if (!release) {
        release = {
          releaseId: row.releaseId,
          tag: row.releaseTag,
          name: row.releaseName,
          draft: row.releaseDraft,
          prerelease: row.releasePrerelease,
          publishedAt: row.releasePublishedAt?.toISOString() ?? null,
          htmlUrl: row.releaseHtmlUrl,
          assetCount: 0,
          totalSizeBytes: 0,
          totalDownloadCount: 0,
        };
        releasesById.set(row.releaseId, release);
      }
      release.assetCount += 1;
      release.totalSizeBytes += row.sizeBytes;
      release.totalDownloadCount += row.downloadCount;

      assets.push({
        id: row.id,
        releaseId: row.releaseId,
        releaseTag: row.releaseTag,
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
        downloadCount: row.downloadCount,
        downloadUrl: row.downloadUrl,
        assetCreatedAt: row.assetCreatedAt?.toISOString() ?? null,
      });
    }

    const snapshotRows = db
      .select({
        capturedAt: storageSnapshots.capturedAt,
        repositorySizeBytes: storageSnapshots.repositorySizeBytes,
        releaseSizeBytes: storageSnapshots.releaseSizeBytes,
        totalSizeBytes: storageSnapshots.totalSizeBytes,
      })
      .from(storageSnapshots)
      .where(and(eq(storageSnapshots.repositoryId, repoId), eq(storageSnapshots.collectionStatus, "complete")))
      .all();

    const series = aggregateSnapshotsByDay(
      snapshotRows.map((row) => ({
        capturedAt: row.capturedAt,
        repositorySizeBytes: row.repositorySizeBytes,
        releaseSizeBytes: row.releaseSizeBytes,
        totalSizeBytes: row.totalSizeBytes,
      })),
    );

    const history: StorageHistoryPoint[] = series.map((point) => ({
      capturedAt: point.capturedAt.toISOString(),
      repositorySizeBytes: point.repositorySizeBytes,
      releaseSizeBytes: point.releaseSizeBytes,
      totalSizeBytes: point.totalSizeBytes,
    }));

    let growth: StorageGrowth | null = null;
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
        rangeDays: null,
      };
    }

    const projectionData = series.length >= 2 ? projectGrowth(series) : null;
    let projection: StorageProjection | null = null;
    if (projectionData) {
      projection = {
        avgBytesPerDay: projectionData.avgBytesPerDay,
        observations: projectionData.observations,
        spanDays: projectionData.spanDays,
        projections: projectionData.projections,
      };
    }

    const data: StorageRepositoryDetailResponse = {
      repository: {
        id: repo.id,
        name: repo.name ?? "",
        fullName: repo.fullName ?? repo.name ?? "",
        mirroredLocation: repo.mirroredLocation,
        htmlUrl,
        instanceUrl,
        provider,
      },
      state: state
        ? {
            repositorySizeBytes: state.repositorySizeBytes,
            releaseSizeBytes: state.releaseSizeBytes,
            totalSizeBytes: state.totalSizeBytes,
            releaseCount: state.releaseCount,
            assetCount: state.assetCount,
            totalDownloadCount: state.totalDownloadCount,
            largestAssetSizeBytes: state.largestAssetSizeBytes,
            collectionStatus: state.collectionStatus,
            lastError: state.lastError,
            lastScannedAt: state.lastScannedAt.toISOString(),
          }
        : null,
      releases: [...releasesById.values()].sort(
        (a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime(),
      ),
      assets,
      history,
      growth,
      projection,
    };

    return jsonResponse({ data, status: 200 });
  } catch (error) {
    return createSecureErrorResponse(error, "storage repository detail", 500);
  }
};
