// DTOs shared between the storage API routes and the Storage Analytics UI.

export interface StorageTotals {
  totalSizeBytes: number;
  repositorySizeBytes: number;
  releaseSizeBytes: number;
  repositoryCount: number;
  releaseCount: number;
  assetCount: number;
  totalDownloadCount: number;
}

export interface StorageInstanceInfo {
  configId: string;
  instanceUrl: string;
  provider: string;
  totalSizeBytes: number;
  repositorySizeBytes: number;
  releaseSizeBytes: number;
  repositoryCount: number;
}

export interface StorageTopRepository {
  repositoryId: string;
  name: string;
  fullName: string;
  mirroredLocation: string | null;
  configId: string;
  instanceUrl: string;
  repositorySizeBytes: number;
  releaseSizeBytes: number;
  totalSizeBytes: number;
  releaseCount: number;
  assetCount: number;
  lastScannedAt: string;
}

export interface StorageLargestAsset {
  id: string;
  repositoryId: string;
  repositoryName: string;
  releaseId: number;
  releaseTag: string;
  releaseName: string | null;
  releaseHtmlUrl: string | null;
  fileName: string;
  sizeBytes: number;
  downloadCount: number;
  downloadUrl: string | null;
  assetCreatedAt: string | null;
  releasePublishedAt: string | null;
}

export interface StorageGrowth {
  currentTotalBytes: number;
  previousTotalBytes: number;
  deltaBytes: number;
  deltaPercent: number | null;
  days: number;
  avgBytesPerDay: number | null;
  rangeDays: number | null;
}

export interface StorageProjectionPoint {
  days: number;
  projectedBytes: number;
}

export interface StorageProjection {
  avgBytesPerDay: number;
  observations: number;
  spanDays: number;
  projections: StorageProjectionPoint[];
}

export interface StorageHistoryPoint {
  capturedAt: string;
  repositorySizeBytes: number;
  releaseSizeBytes: number;
  totalSizeBytes: number;
}

export interface StorageScanStateSummary {
  complete: number;
  partial: number;
  error: number;
  lastScannedAt: string | null;
  lastError: string | null;
}

export interface StorageOverviewResponse {
  totals: StorageTotals;
  perInstance: StorageInstanceInfo[];
  topRepositories: StorageTopRepository[];
  largestAssets: StorageLargestAsset[];
  growth: StorageGrowth | null;
  scan: StorageScanStateSummary;
  scanStatus: StorageScanStatusDto | null;
}

export interface StorageScanStatusDto {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  repositoriesScanned: number;
  repositoriesFailed: number;
  repositoriesSkipped: number;
  error: string | null;
  failures: Array<{ repositoryId: string; repositoryName: string; reason: string }>;
}

export interface StorageReleaseRow {
  releaseId: number;
  tag: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  htmlUrl: string | null;
  assetCount: number;
  totalSizeBytes: number;
  totalDownloadCount: number;
}

export interface StorageAssetRow {
  id: string;
  releaseId: number;
  releaseTag: string;
  fileName: string;
  sizeBytes: number;
  downloadCount: number;
  downloadUrl: string | null;
  assetCreatedAt: string | null;
}

export interface StorageRepositoryDetailResponse {
  repository: {
    id: string;
    name: string;
    fullName: string;
    mirroredLocation: string | null;
    htmlUrl: string | null;
    instanceUrl: string;
    provider: string;
  };
  state: {
    repositorySizeBytes: number;
    releaseSizeBytes: number;
    totalSizeBytes: number;
    releaseCount: number;
    assetCount: number;
    totalDownloadCount: number;
    largestAssetSizeBytes: number;
    collectionStatus: string;
    lastError: string | null;
    lastScannedAt: string;
  } | null;
  releases: StorageReleaseRow[];
  assets: StorageAssetRow[];
  history: StorageHistoryPoint[];
  growth: StorageGrowth | null;
  projection: StorageProjection | null;
}

export type StorageRangeKey = "7" | "30" | "90" | "180" | "365" | "all";
