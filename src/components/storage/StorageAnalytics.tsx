import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Database,
  ExternalLink,
  FileArchive,
  FolderGit2,
  GitBranch,
  Package,
  RefreshCw,
  Tag,
  TriangleAlert,
  ArrowLeft,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/utils";
import { formatStorageBytes, formatPercent, formatCount } from "@/lib/utils/format-storage";
import type {
  StorageAssetRow,
  StorageGrowth,
  StorageHistoryPoint,
  StorageLargestAsset,
  StorageOverviewResponse,
  StorageProjection,
  StorageReleaseRow,
  StorageRepositoryDetailResponse,
  StorageScanStatusDto,
  StorageTopRepository,
} from "@/types/storage";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
  { value: "all", label: "All time" },
] as const;

const SIZE_FILTERS = [
  { value: "", label: "Any size" },
  { value: String(100 * 1024 * 1024), label: "> 100 MiB" },
  { value: String(500 * 1024 * 1024), label: "> 500 MiB" },
  { value: String(1024 * 1024 * 1024), label: "> 1 GiB" },
] as const;

const DOWNLOAD_FILTERS = [
  { value: "", label: "Any download count" },
  { value: "9", label: "< 10 downloads" },
  { value: "0", label: "No downloads" },
] as const;

const AGE_FILTERS = [
  { value: "", label: "Any age" },
  { value: "90", label: "Older than 90 days" },
  { value: "180", label: "Older than 180 days" },
  { value: "365", label: "Older than 365 days" },
] as const;

function formatDate(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleDateString("en-GB");
}

function formatDateTime(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "–"
    : `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

// ===== Small building blocks =====

function KpiCard({
  title,
  value,
  sub,
  icon: Icon,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: typeof Database;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="text-2xl font-semibold">{value}</div>
        {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

// Pure SVG donut – no chart library is installed and none is needed for two
// categories. Segments show absolute sizes plus share.
function StorageDonut({ segments, centerLabel }: { segments: DonutSegment[]; centerLabel: string }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="Storage distribution">
        <circle cx="80" cy="80" r={radius} fill="none" stroke="currentColor" strokeWidth="18" className="text-muted" opacity={total > 0 ? 0.25 : 1} />
        {total > 0 &&
          segments.map((segment) => {
            const share = segment.value / total;
            const dash = share * circumference;
            const element = (
              <circle
                key={segment.label}
                cx="80"
                cy="80"
                r={radius}
                fill="none"
                strokeWidth="18"
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 80 80)"
                stroke={segment.color}
              />
            );
            offset += dash;
            return element;
          })}
        <text x="80" y="76" textAnchor="middle" className="fill-foreground text-sm font-semibold">
          {formatStorageBytes(total)}
        </text>
        <text x="80" y="94" textAnchor="middle" className="fill-muted-foreground" fontSize="10">
          {centerLabel}
        </text>
      </svg>
      <div className="space-y-2">
        {segments.map((segment) => {
          const share = total > 0 ? (segment.value / total) * 100 : 0;
          return (
            <div key={segment.label} className="flex items-center gap-2 text-sm">
              <span className="h-3 w-3 rounded-sm" style={{ background: segment.color }} />
              <span>{segment.label}</span>
              <span className="font-medium">{formatStorageBytes(segment.value)}</span>
              <span className="text-muted-foreground">({share.toFixed(1)} %)</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Inline style fallbacks keep the SVG strokes correct regardless of whether
// the current Tailwind palette defines matching stroke utilities.
function segmentStyle(color: string): { stroke: string } {
  return { stroke: color };
}

// History line chart. Missing measurement days become separate polyline
// segments – a gap in the data is drawn as a gap, never as a drop to zero.
function HistoryChart({ points }: { points: StorageHistoryPoint[] }) {
  const width = 720;
  const height = 220;
  const padding = { top: 12, right: 12, bottom: 24, left: 56 };

  if (points.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">No measurements captured yet.</div>;
  }

  const times = points.map((p) => new Date(p.capturedAt).getTime());
  const maxBytes = Math.max(...points.map((p) => p.totalSizeBytes), 1);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const spanX = Math.max(maxTime - minTime, DAY_MS);

  const x = (t: number) => padding.left + ((t - minTime) / spanX) * (width - padding.left - padding.right);
  const y = (bytes: number) => height - padding.bottom - (bytes / maxBytes) * (height - padding.top - padding.bottom);

  // Split into contiguous segments: a break larger than 36h means a gap.
  const segments: StorageHistoryPoint[][] = [];
  let current: StorageHistoryPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    current.push(points[i]);
    const next = points[i + 1];
    if (!next || new Date(next.capturedAt).getTime() - new Date(points[i].capturedAt).getTime() > 36 * 60 * 60 * 1000) {
      segments.push(current);
      current = [];
    }
  }

  const buildLine = (pick: (p: StorageHistoryPoint) => number) =>
    segments.map((segment) =>
      segment
        .map((p) => `${x(new Date(p.capturedAt).getTime()).toFixed(1)},${y(pick(p)).toFixed(1)}`)
        .join(" "),
    );

  const totalLine = buildLine((p) => p.totalSizeBytes);
  const repoLine = buildLine((p) => p.repositorySizeBytes);
  const releaseLine = buildLine((p) => p.releaseSizeBytes);

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="w-full overflow-x-auto">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="min-w-[520px]">
        {gridLines.map((ratio) => {
          const gy = height - padding.bottom - ratio * (height - padding.top - padding.bottom);
          return (
            <g key={ratio}>
              <line x1={padding.left} x2={width - padding.right} y1={gy} y2={gy} stroke="currentColor" strokeOpacity={0.12} />
              <text x={padding.left - 6} y={gy + 3} textAnchor="end" fontSize="9" className="fill-muted-foreground">
                {formatStorageBytes(maxBytes * ratio)}
              </text>
            </g>
          );
        })}
        {totalLine.map((line, i) => (
          <polyline key={`t${i}`} points={line} fill="none" strokeWidth="2" {...segmentStyle("#6366f1")} />
        ))}
        {repoLine.map((line, i) => (
          <polyline key={`r${i}`} points={line} fill="none" strokeWidth="1.5" strokeDasharray="4 3" {...segmentStyle("#10b981")} />
        ))}
        {releaseLine.map((line, i) => (
          <polyline key={`a${i}`} points={line} fill="none" strokeWidth="1.5" strokeDasharray="2 3" {...segmentStyle("#f59e0b")} />
        ))}
        <text x={padding.left} y={12} fontSize="9" className="fill-muted-foreground">
          {formatDate(points[0].capturedAt)}
        </text>
        <text x={width - padding.right} y={12} textAnchor="end" fontSize="9" className="fill-muted-foreground">
          {formatDate(points[points.length - 1].capturedAt)}
        </text>
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block h-[2px] w-4" style={{ background: "#6366f1" }} /> Total</span>
        <span className="flex items-center gap-1"><span className="inline-block h-[2px] w-4" style={{ background: "#10b981" }} /> Git + LFS</span>
        <span className="flex items-center gap-1"><span className="inline-block h-[2px] w-4" style={{ background: "#f59e0b" }} /> Release assets</span>
      </div>
    </div>
  );
}

function GrowthLine({ growth }: { growth: StorageGrowth | null }) {
  if (!growth) {
    return <span className="text-muted-foreground">Not enough history yet (need at least two snapshots).</span>;
  }
  const positive = growth.deltaBytes >= 0;
  return (
    <span className={positive ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}>
      {positive ? "+" : ""}
      {formatStorageBytes(growth.deltaBytes)}
      {growth.deltaPercent !== null ? ` (${formatPercent(growth.deltaPercent)})` : ""}
      {growth.avgBytesPerDay !== null ? (
        <span className="text-muted-foreground"> · avg {formatStorageBytes(growth.avgBytesPerDay)}/day</span>
      ) : null}
    </span>
  );
}

type SortDirection = "asc" | "desc";

interface SortState {
  key: string;
  direction: SortDirection;
}

function sortRows<T>(rows: T[], sort: SortState, accessors: Record<string, (row: T) => number | string>): T[] {
  const accessor = accessors[sort.key];
  if (!accessor) return rows;
  const sorted = [...rows].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (typeof av === "number" && typeof bv === "number") {
      return sort.direction === "asc" ? av - bv : bv - av;
    }
    return sort.direction === "asc"
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });
  return sorted;
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`cursor-pointer select-none px-2 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground ${className ?? ""}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (sort.direction === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null}
      </span>
    </th>
  );
}

// ===== Main component =====

export function StorageAnalytics() {
  const [overview, setOverview] = useState<StorageOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [configFilter, setConfigFilter] = useState<string>("");
  const [range, setRange] = useState<string>("30");
  const [search, setSearch] = useState("");

  const [scanStatus, setScanStatus] = useState<StorageScanStatusDto | null>(null);

  const [topSort, setTopSort] = useState<SortState>({ key: "total", direction: "desc" });
  const [assetSort, setAssetSort] = useState<SortState>({ key: "size", direction: "desc" });

  const [sizeFilter, setSizeFilter] = useState<string>("");
  const [downloadFilter, setDownloadFilter] = useState<string>("");
  const [ageFilter, setAgeFilter] = useState<string>("");
  const [lowUsageMode, setLowUsageMode] = useState(false);

  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StorageRepositoryDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRange, setDetailRange] = useState<string>("all");
  const [expandedRelease, setExpandedRelease] = useState<number | null>(null);
  const [releaseSort, setReleaseSort] = useState<SortState>({ key: "size", direction: "desc" });
  const [assetDetailSort, setAssetDetailSort] = useState<SortState>({ key: "size", direction: "desc" });

  const loadOverview = useCallback(async () => {
    const query = new URLSearchParams();
    if (configFilter) query.set("configId", configFilter);
    query.set("range", range);
    query.set("assets", "100");
    try {
      const data = await apiRequest<StorageOverviewResponse>(`/storage/overview?${query.toString()}`);
      setOverview(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load storage data");
    } finally {
      setLoading(false);
    }
  }, [configFilter, range]);

  useEffect(() => {
    setLoading(true);
    void loadOverview();
  }, [loadOverview]);

  // Poll the scan status while a background scan is running.
  useEffect(() => {
    if (!scanStatus?.running) return;
    const timer = setInterval(async () => {
      try {
        const status = await apiRequest<StorageScanStatusDto>("/storage/scan-status");
        setScanStatus(status);
        if (!status.running) {
          void loadOverview();
        }
      } catch {
        // Keep polling on transient errors.
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [scanStatus?.running, loadOverview]);

  const startScan = useCallback(async () => {
    setError(null);
    try {
      await apiRequest("/storage/scan", {
        method: "POST",
        data: configFilter ? { configId: configFilter } : {},
      });
      const status = await apiRequest<StorageScanStatusDto>("/storage/scan-status");
      setScanStatus(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start scan";
      if (!message.includes("already running")) {
        setError(message);
      } else {
        const status = await apiRequest<StorageScanStatusDto>("/storage/scan-status").catch(() => null);
        if (status) setScanStatus(status);
      }
    }
  }, [configFilter]);

  const openRepository = useCallback(async (repositoryId: string) => {
    setSelectedRepoId(repositoryId);
    setDetail(null);
    setExpandedRelease(null);
    setDetailLoading(true);
    try {
      const query = new URLSearchParams();
      query.set("range", detailRange);
      const data = await apiRequest<StorageRepositoryDetailResponse>(
        `/storage/repository/${repositoryId}?${query.toString()}`,
      );
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load repository details");
    } finally {
      setDetailLoading(false);
    }
  }, [detailRange]);

  const filteredTop = useMemo(() => {
    if (!overview) return [];
    const rows = search.trim()
      ? overview.topRepositories.filter(
          (row) =>
            row.fullName.toLowerCase().includes(search.trim().toLowerCase()) ||
            row.name.toLowerCase().includes(search.trim().toLowerCase()) ||
            (row.mirroredLocation ?? "").toLowerCase().includes(search.trim().toLowerCase()),
        )
      : overview.topRepositories;
    return sortRows(rows, topSort, {
      total: (row) => row.totalSizeBytes,
      repo: (row) => row.repositorySizeBytes,
      release: (row) => row.releaseSizeBytes,
      releases: (row) => row.releaseCount,
      assets: (row) => row.assetCount,
      name: (row) => row.fullName,
      scanned: (row) => new Date(row.lastScannedAt).getTime(),
    });
  }, [overview, search, topSort]);

  const filteredAssets = useMemo(() => {
    if (!overview) return [];
    let rows = overview.largestAssets;
    if (lowUsageMode) {
      const minSize = sizeFilter ? Number(sizeFilter) : 0;
      const maxDownloads = downloadFilter ? Number(downloadFilter) : Number.POSITIVE_INFINITY;
      const olderThanDays = ageFilter ? Number(ageFilter) : null;
      const now = Date.now();
      rows = rows.filter((asset) => {
        if (asset.sizeBytes < minSize) return false;
        if (asset.downloadCount > maxDownloads) return false;
        if (olderThanDays !== null) {
          const published = asset.releasePublishedAt ? new Date(asset.releasePublishedAt).getTime() : null;
          if (published === null || now - published < olderThanDays * DAY_MS) return false;
        }
        return true;
      });
    }
    return sortRows(rows, assetSort, {
      size: (row) => row.sizeBytes,
      downloads: (row) => row.downloadCount,
      name: (row) => row.fileName,
      uploaded: (row) => (row.assetCreatedAt ? new Date(row.assetCreatedAt).getTime() : 0),
    });
  }, [overview, lowUsageMode, sizeFilter, downloadFilter, ageFilter, assetSort]);

  const makeToggleSort =
    (setter: (updater: (prev: SortState) => SortState) => void) => (key: string) =>
      setter((prev) =>
        prev.key === key
          ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
          : { key, direction: "desc" },
      );

  const totals = overview?.totals;
  const releaseShare = totals && totals.totalSizeBytes > 0
    ? (totals.releaseSizeBytes / totals.totalSizeBytes) * 100
    : 0;

  // ===== Repository detail view =====
  if (selectedRepoId) {
    const releaseRows = detail
      ? sortRows(detail.releases, releaseSort, {
          size: (row) => row.totalSizeBytes,
          published: (row) => (row.publishedAt ? new Date(row.publishedAt).getTime() : 0),
          assets: (row) => row.assetCount,
          downloads: (row) => row.totalDownloadCount,
          name: (row) => row.name || row.tag,
        })
      : [];

    const releaseAssets = detail && expandedRelease !== null
      ? sortRows(
          detail.assets.filter((asset) => asset.releaseId === expandedRelease),
          assetDetailSort,
          {
            size: (row) => row.sizeBytes,
            downloads: (row) => row.downloadCount,
            name: (row) => row.fileName,
          },
        )
      : [];

    const largestRelease = detail && detail.releases.length > 0
      ? detail.releases.reduce((best, row) => (row.totalSizeBytes > best.totalSizeBytes ? row : best))
      : null;
    const largestAsset = detail && detail.assets.length > 0
      ? detail.assets.reduce((best, row) => (row.sizeBytes > best.sizeBytes ? row : best))
      : null;

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelectedRepoId(null)}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Button>
            <h1 className="text-xl font-semibold truncate">
              {detail?.repository.fullName ?? "Repository"}
            </h1>
          </div>
          {detail?.repository.htmlUrl ? (
            <a
              href={detail.repository.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Open in Gitea <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>

        {detail?.state?.collectionStatus && detail.state.collectionStatus !== "complete" ? (
          <div className="flex items-center gap-2 rounded-md border border-amber-400/60 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            <span>
              Last scan was {detail.state.collectionStatus}
              {detail.state.lastError ? `: ${detail.state.lastError}` : ""}. Numbers below reflect
              the last complete scan on {formatDateTime(detail.state.lastScannedAt)}.
            </span>
          </div>
        ) : null}

        {detailLoading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading repository data…</div>
        ) : !detail || !detail.state ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            This repository has not been scanned yet. Use &quot;Scan now&quot; on the dashboard.
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="Tracked total" value={formatStorageBytes(detail.state.totalSizeBytes)} icon={Database}
                sub={`Last scan: ${formatDateTime(detail.state.lastScannedAt)}`} />
              <KpiCard title="Git + LFS" value={formatStorageBytes(detail.state.repositorySizeBytes)} icon={FolderGit2} />
              <KpiCard title="Release assets" value={formatStorageBytes(detail.state.releaseSizeBytes)} icon={FileArchive} />
              <KpiCard
                title="Releases / Assets"
                value={`${formatCount(detail.state.releaseCount)} / ${formatCount(detail.state.assetCount)}`}
                icon={Package}
                sub={`Avg per release: ${detail.state.releaseCount > 0 ? formatStorageBytes(detail.state.releaseSizeBytes / detail.state.releaseCount) : "–"}`}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Largest release</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm">
                  {largestRelease ? (
                    <>
                      <span className="font-medium">{largestRelease.name || largestRelease.tag || `Release #${largestRelease.releaseId}`}</span>
                      <span className="ml-2 text-muted-foreground">{formatStorageBytes(largestRelease.totalSizeBytes)}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No releases</span>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Largest single file</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm">
                  {largestAsset ? (
                    <>
                      <span className="font-medium">{largestAsset.fileName}</span>
                      <span className="ml-2 text-muted-foreground">
                        {formatStorageBytes(largestAsset.sizeBytes)} · {formatCount(largestAsset.downloadCount)} downloads
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No assets</span>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Storage history</CardTitle>
                  <select
                    value={detailRange}
                    onChange={(e) => setDetailRange(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  >
                    {RANGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <CardDescription className="text-xs">
                  Gaps mean no measurement was taken; they are not zero values. Growth: <GrowthLine growth={detail.growth} />
                </CardDescription>
              </CardHeader>
              <CardContent>
                <HistoryChart points={detail.history} />
                {detail.projection ? <ProjectionBlock projection={detail.projection} /> : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Releases</CardTitle>
                <CardDescription className="text-xs">Click a release to see its files.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Release</th>
                        <SortHeader label="Published" sortKey="published" sort={releaseSort} onSort={makeToggleSort(setReleaseSort)} />
                        <SortHeader label="Assets" sortKey="assets" sort={releaseSort} onSort={makeToggleSort(setReleaseSort)} className="text-right" />
                        <SortHeader label="Total size" sortKey="size" sort={releaseSort} onSort={makeToggleSort(setReleaseSort)} className="text-right" />
                        <SortHeader label="Downloads" sortKey="downloads" sort={releaseSort} onSort={makeToggleSort(setReleaseSort)} className="text-right" />
                        <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {releaseRows.map((release) => (
                        <ReleaseRowGroup
                          key={release.releaseId}
                          release={release}
                          expanded={expandedRelease === release.releaseId}
                          onToggle={() =>
                            setExpandedRelease((prev) => (prev === release.releaseId ? null : release.releaseId))
                          }
                        />
                      ))}
                      {releaseRows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                            No releases captured for this repository.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {expandedRelease !== null ? (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    Files in release{" "}
                    {detail.releases.find((r) => r.releaseId === expandedRelease)?.name ||
                      detail.releases.find((r) => r.releaseId === expandedRelease)?.tag ||
                      `#${expandedRelease}`}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <SortHeader label="File" sortKey="name" sort={assetDetailSort} onSort={makeToggleSort(setAssetDetailSort)} />
                          <SortHeader label="Size" sortKey="size" sort={assetDetailSort} onSort={makeToggleSort(setAssetDetailSort)} className="text-right" />
                          <SortHeader label="Downloads" sortKey="downloads" sort={assetDetailSort} onSort={makeToggleSort(setAssetDetailSort)} className="text-right" />
                          <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Uploaded</th>
                          <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Link</th>
                        </tr>
                      </thead>
                      <tbody>
                        {releaseAssets.map((asset) => (
                          <tr key={asset.id} className="border-b last:border-0">
                            <td className="px-2 py-2">{asset.fileName}</td>
                            <td className="px-2 py-2 tabular-nums">{formatStorageBytes(asset.sizeBytes)}</td>
                            <td className="px-2 py-2 tabular-nums">{formatCount(asset.downloadCount)}</td>
                            <td className="px-2 py-2 text-muted-foreground">{formatDate(asset.assetCreatedAt)}</td>
                            <td className="px-2 py-2">
                              {asset.downloadUrl ? (
                                <a href={asset.downloadUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                  Download
                                </a>
                              ) : (
                                "–"
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            ) : null}
          </>
        )}
      </div>
    );
  }

  // ===== Overview / dashboard view =====
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Storage Analytics</h1>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={configFilter}
            onChange={(e) => setConfigFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Gitea instance filter"
          >
            <option value="">All instances</option>
            {(overview?.perInstance ?? []).map((instance) => (
              <option key={instance.configId} value={instance.configId}>
                {instance.instanceUrl || instance.configId}
              </option>
            ))}
          </select>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Growth period"
          >
            {RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <Button size="sm" onClick={() => void startScan()} disabled={scanStatus?.running}>
            <RefreshCw className={`mr-1 h-4 w-4 ${scanStatus?.running ? "animate-spin" : ""}`} />
            {scanStatus?.running ? "Scanning…" : "Scan now"}
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-md border p-3 text-xs text-muted-foreground">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          These figures show the storage the Gitea API reports for managed repositories
          (repository size including counted LFS data, plus release attachments). It is an
          estimate of tracked storage, not a physical disk analysis: Actions artifacts,
          package registries, attachments, database size and filesystem overhead are not
          covered, and free disk space on the Gitea server cannot be read via the API.
        </span>
      </div>

      {error ? (
        <div className="flex items-center justify-between rounded-md border border-red-400/60 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={() => void loadOverview()}>Retry</Button>
        </div>
      ) : null}

      {scanStatus?.running ? (
        <div className="rounded-md border border-blue-400/60 bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-300">
          Storage scan running… scanned {scanStatus.repositoriesScanned}, failed{" "}
          {scanStatus.repositoriesFailed}, skipped {scanStatus.repositoriesSkipped}.
        </div>
      ) : scanStatus && (scanStatus.failures.length > 0 || scanStatus.error) ? (
        <div className="rounded-md border border-amber-400/60 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          Last scan finished at {formatDateTime(scanStatus.finishedAt)}: {scanStatus.repositoriesScanned}{" "}
          scanned, {scanStatus.repositoriesFailed} failed, {scanStatus.repositoriesSkipped} skipped.
          {scanStatus.error ? ` ${scanStatus.error}` : ""}
          {scanStatus.failures.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-xs">
              {scanStatus.failures.slice(0, 8).map((failure) => (
                <li key={failure.repositoryId}>
                  {failure.repositoryName}: {failure.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading storage data…</div>
      ) : overview ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <KpiCard title="Total storage" value={formatStorageBytes(totals?.totalSizeBytes)} icon={Database}
              sub="Git + LFS + release assets" />
            <KpiCard title="Repository storage" value={formatStorageBytes(totals?.repositorySizeBytes)} icon={FolderGit2}
              sub="Git incl. LFS (as counted by Gitea)" />
            <KpiCard title="Release storage" value={formatStorageBytes(totals?.releaseSizeBytes)} icon={FileArchive}
              sub={`${releaseShare.toFixed(1)} % of tracked total`} />
            <KpiCard title="Repositories" value={formatCount(totals?.repositoryCount)} icon={GitBranch} />
            <KpiCard
              title="Releases / Assets"
              value={`${formatCount(totals?.releaseCount)} / ${formatCount(totals?.assetCount)}`}
              icon={Package}
            />
            <KpiCard title={`Growth (${range === "all" ? "all time" : `${range}d`})`}
              value={overview.growth ? `${overview.growth.deltaBytes >= 0 ? "+" : ""}${formatStorageBytes(overview.growth.deltaBytes)}` : "–"}
              sub={overview.growth?.deltaPercent != null ? formatPercent(overview.growth.deltaPercent) : "Needs 2+ snapshots"}
              icon={ArrowUp} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Storage distribution</CardTitle>
                <CardDescription className="text-xs">
                  Last complete scan: {formatDateTime(overview.scan.lastScannedAt)} ·{" "}
                  {overview.scan.complete} complete, {overview.scan.partial} partial, {overview.scan.error} error
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StorageDonut
                  centerLabel="tracked total"
                  segments={[
                    { label: "Git + LFS", value: totals?.repositorySizeBytes ?? 0, color: "#10b981" },
                    { label: "Release assets", value: totals?.releaseSizeBytes ?? 0, color: "#f59e0b" },
                  ]}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Storage per instance</CardTitle>
                <CardDescription className="text-xs">Identical repositories are counted per instance.</CardDescription>
              </CardHeader>
              <CardContent>
                {overview.perInstance.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No instance data yet.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Instance</th>
                          <th className="px-2 py-2 text-right text-xs font-medium text-muted-foreground">Repos</th>
                          <th className="px-2 py-2 text-right text-xs font-medium text-muted-foreground">Git + LFS</th>
                          <th className="px-2 py-2 text-right text-xs font-medium text-muted-foreground">Releases</th>
                          <th className="px-2 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.perInstance.map((instance) => (
                          <tr key={instance.configId} className="border-b last:border-0">
                            <td className="px-2 py-2">{instance.instanceUrl || instance.configId}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{instance.repositoryCount}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{formatStorageBytes(instance.repositorySizeBytes)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{formatStorageBytes(instance.releaseSizeBytes)}</td>
                            <td className="px-2 py-2 text-right font-medium tabular-nums">{formatStorageBytes(instance.totalSizeBytes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm">Top storage consumers</CardTitle>
                <Input
                  placeholder="Search repository…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 w-56"
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <SortHeader label="Repository" sortKey="name" sort={topSort} onSort={makeToggleSort(setTopSort)} />
                      <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Instance</th>
                      <SortHeader label="Git + LFS" sortKey="repo" sort={topSort} onSort={makeToggleSort(setTopSort)} className="text-right" />
                      <SortHeader label="Releases" sortKey="release" sort={topSort} onSort={makeToggleSort(setTopSort)} className="text-right" />
                      <SortHeader label="Total" sortKey="total" sort={topSort} onSort={makeToggleSort(setTopSort)} className="text-right" />
                      <SortHeader label="#" sortKey="releases" sort={topSort} onSort={makeToggleSort(setTopSort)} className="text-right" />
                      <SortHeader label="Files" sortKey="assets" sort={topSort} onSort={makeToggleSort(setTopSort)} className="text-right" />
                      <SortHeader label="Last scan" sortKey="scanned" sort={topSort} onSort={makeToggleSort(setTopSort)} />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTop.map((row) => (
                      <TopRepositoryRow key={row.repositoryId} row={row} onOpen={() => void openRepository(row.repositoryId)} />
                    ))}
                    {filteredTop.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">
                          No scanned repositories match. Trigger &quot;Scan now&quot; to collect data.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm">Largest release files</CardTitle>
                <Button
                  size="sm"
                  variant={lowUsageMode ? "default" : "outline"}
                  onClick={() => setLowUsageMode((prev) => !prev)}
                >
                  Low-usage analysis
                </Button>
              </div>
              {lowUsageMode ? (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <select value={sizeFilter} onChange={(e) => setSizeFilter(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm">
                    {SIZE_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <select value={downloadFilter} onChange={(e) => setDownloadFilter(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm">
                    {DOWNLOAD_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <select value={ageFilter} onChange={(e) => setAgeFilter(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm">
                    {AGE_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <span className="text-xs text-muted-foreground">
                    Possible cleanup candidates only – nothing is ever deleted automatically.
                    Download counts are per Gitea instance and say nothing about downloads of the
                    original project.
                  </span>
                </div>
              ) : null}
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <SortHeader label="File" sortKey="name" sort={assetSort} onSort={makeToggleSort(setAssetSort)} />
                      <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Repository</th>
                      <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Release</th>
                      <SortHeader label="Size" sortKey="size" sort={assetSort} onSort={makeToggleSort(setAssetSort)} className="text-right" />
                      <SortHeader label="Downloads" sortKey="downloads" sort={assetSort} onSort={makeToggleSort(setAssetSort)} className="text-right" />
                      <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAssets.slice(0, 20).map((asset: StorageLargestAsset) => (
                      <tr key={asset.id} className="border-b last:border-0">
                        <td className="px-2 py-2 max-w-[16rem] truncate" title={asset.fileName}>{asset.fileName}</td>
                        <td className="px-2 py-2 max-w-[14rem] truncate">
                          <button
                            className="text-primary hover:underline text-left"
                            onClick={() => void openRepository(asset.repositoryId)}
                          >
                            {asset.repositoryName}
                          </button>
                        </td>
                        <td className="px-2 py-2">
                          {asset.releaseHtmlUrl ? (
                            <a href={asset.releaseHtmlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                              <Tag className="h-3 w-3" /> {asset.releaseName || asset.releaseTag}
                            </a>
                          ) : (
                            asset.releaseName || asset.releaseTag
                          )}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums font-medium">{formatStorageBytes(asset.sizeBytes)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatCount(asset.downloadCount)}</td>
                        <td className="px-2 py-2">
                          {asset.downloadUrl ? (
                            <a href={asset.downloadUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                              <ExternalLink className="h-3 w-3" /> File
                            </a>
                          ) : "–"}
                        </td>
                      </tr>
                    ))}
                    {filteredAssets.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                          No release assets captured yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

// ===== Sub-rows =====

function TopRepositoryRow({ row, onOpen }: { row: StorageTopRepository; onOpen: () => void }) {
  return (
    <tr className="border-b last:border-0 hover:bg-muted/40">
      <td className="px-2 py-2">
        <button className="text-primary hover:underline text-left max-w-[16rem] truncate block" onClick={onOpen}>
          {row.fullName || row.name}
        </button>
      </td>
      <td className="px-2 py-2 text-muted-foreground max-w-[12rem] truncate">{row.instanceUrl || "–"}</td>
      <td className="px-2 py-2 text-right tabular-nums">{formatStorageBytes(row.repositorySizeBytes)}</td>
      <td className="px-2 py-2 text-right tabular-nums">{formatStorageBytes(row.releaseSizeBytes)}</td>
      <td className="px-2 py-2 text-right font-medium tabular-nums">{formatStorageBytes(row.totalSizeBytes)}</td>
      <td className="px-2 py-2 text-right tabular-nums">{row.releaseCount}</td>
      <td className="px-2 py-2 text-right tabular-nums">{row.assetCount}</td>
      <td className="px-2 py-2 text-muted-foreground whitespace-nowrap">{formatDate(row.lastScannedAt)}</td>
    </tr>
  );
}

function ReleaseRowGroup({
  release,
  expanded,
  onToggle,
}: {
  release: StorageReleaseRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const typeLabel = release.draft ? "Draft" : release.prerelease ? "Pre-release" : "Stable";
  const typeClass = release.draft
    ? "bg-gray-500"
    : release.prerelease
      ? "bg-amber-500"
      : "bg-emerald-500";
  return (
    <>
      <tr className={`border-b last:border-0 cursor-pointer hover:bg-muted/40 ${expanded ? "bg-muted/40" : ""}`} onClick={onToggle}>
        <td className="px-2 py-2">
          {release.htmlUrl ? (
            <a
              href={release.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {release.name || release.tag || `Release #${release.releaseId}`}
            </a>
          ) : (
            release.name || release.tag || `Release #${release.releaseId}`
          )}
        </td>
        <td className="px-2 py-2 text-muted-foreground whitespace-nowrap">{formatDate(release.publishedAt)}</td>
        <td className="px-2 py-2 text-right tabular-nums">{release.assetCount}</td>
        <td className="px-2 py-2 text-right tabular-nums">{formatStorageBytes(release.totalSizeBytes)}</td>
        <td className="px-2 py-2 text-right tabular-nums">{formatCount(release.totalDownloadCount)}</td>
        <td className="px-2 py-2">
          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-white ${typeClass}`}>
            {typeLabel}
          </span>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={6} className="px-4 py-2 text-xs text-muted-foreground">
            {release.assetCount} file{release.assetCount === 1 ? "" : "s"} ·{" "}
            {formatStorageBytes(release.totalSizeBytes)} total. See the file list below the table.
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ProjectionBlock({ projection }: { projection: StorageProjection }) {
  return (
    <div className="mt-3 rounded-md border p-3 text-xs">
      <div className="mb-1 font-medium text-foreground">Growth projection (tracked storage only, not free disk space)</div>
      <div className="flex flex-wrap gap-4 text-muted-foreground">
        <span>Avg {formatStorageBytes(projection.avgBytesPerDay)}/day over {Math.round(projection.spanDays)} days</span>
        {projection.projections.map((point) => (
          <span key={point.days}>
            in {point.days} days: <span className="font-medium text-foreground">{formatStorageBytes(point.projectedBytes)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
