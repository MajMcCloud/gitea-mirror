import type { APIRoute } from "astro";
import { and, eq, sql } from "drizzle-orm";
import { db, storageSnapshots } from "@/lib/db";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import {
  aggregateSnapshotsByDay,
  computeGrowth,
  projectGrowth,
} from "@/lib/storage-analytics";
import type { StorageGrowth, StorageHistoryPoint, StorageProjection } from "@/types/storage";

const RANGE_DAYS: Record<string, number> = {
  "7": 7,
  "30": 30,
  "90": 90,
  "180": 180,
  "365": 365,
};

/**
 * Daily aggregated storage history for the line chart.
 *
 * Only "complete" snapshots count. Days without a measurement are simply
 * absent from the series; the UI renders them as data gaps, never as zero.
 *
 * GET /api/storage/history?range=30|90|180|365|all&configId=&repositoryId=
 */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const params = new URL(request.url).searchParams;
    const rangeRaw = params.get("range") || "30";
    const configId = params.get("configId") || null;
    const repositoryId = params.get("repositoryId") || null;
    const rangeDays = RANGE_DAYS[rangeRaw] ?? null;

    const conditions = [
      eq(storageSnapshots.userId, userId),
      eq(storageSnapshots.collectionStatus, "complete"),
      ...(configId ? [eq(storageSnapshots.configId, configId)] : []),
      ...(repositoryId ? [eq(storageSnapshots.repositoryId, repositoryId)] : []),
      ...(rangeDays
        ? [sql`${storageSnapshots.capturedAt} >= ${Math.floor((Date.now() - rangeDays * 86_400_000) / 1000)}`]
        : []),
    ];

    const rows = db
      .select({
        capturedAt: storageSnapshots.capturedAt,
        repositorySizeBytes: storageSnapshots.repositorySizeBytes,
        releaseSizeBytes: storageSnapshots.releaseSizeBytes,
        totalSizeBytes: storageSnapshots.totalSizeBytes,
      })
      .from(storageSnapshots)
      .where(and(...conditions))
      .all();

    const points = rows.map((row) => ({
      capturedAt: row.capturedAt,
      repositorySizeBytes: row.repositorySizeBytes,
      releaseSizeBytes: row.releaseSizeBytes,
      totalSizeBytes: row.totalSizeBytes,
    }));

    const series = aggregateSnapshotsByDay(points);
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
        rangeDays,
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

    return jsonResponse({ data: { series: history, growth, projection }, status: 200 });
  } catch (error) {
    return createSecureErrorResponse(error, "storage history", 500);
  }
};
