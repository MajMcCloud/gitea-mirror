import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import {
  storageReleaseAssets,
  storageSnapshots,
  storageStates,
} from "@/lib/db/schema";
import type { RepoStorageMeasure } from "./storage-analytics";
import { persistRepositoryStorage } from "./storage-service";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(
    `CREATE TABLE users (id text primary key);
     CREATE TABLE repositories (id text primary key);`,
  );
  const migrationFile = readdirSync("./drizzle")
    .filter((file) => file.startsWith("0021_") && file.endsWith(".sql"))
    .sort()[0];
  if (!migrationFile) {
    throw new Error("storage migration file not found under ./drizzle");
  }
  sqlite.exec(readFileSync(`./drizzle/${migrationFile}`, "utf8"));
  return drizzle(sqlite);
}

type Measure = RepoStorageMeasure;

function makeMeasure(releases: Array<{ id: number; tag: string; assets: Array<{ id: number; name: string; size: number; downloads: number }> }>): Measure {
  const mappedReleases = releases.map((release) => ({
    id: release.id,
    tag: release.tag,
    name: release.tag,
    draft: false,
    prerelease: false,
    publishedAt: new Date("2024-01-01T00:00:00Z"),
    htmlUrl: `http://gitea.local/o/r/releases/tag/${release.tag}`,
    assets: release.assets.map((asset) => ({
      id: asset.id,
      uuid: null,
      name: asset.name,
      sizeBytes: asset.size,
      downloadCount: asset.downloads,
      downloadUrl: `http://gitea.local/attachments/${asset.id}`,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    })),
  }));

  let releaseSize = 0;
  let assetCount = 0;
  let downloads = 0;
  let largest = 0;
  for (const release of mappedReleases) {
    for (const asset of release.assets) {
      releaseSize += asset.sizeBytes;
      assetCount += 1;
      downloads += asset.downloadCount;
      largest = Math.max(largest, asset.sizeBytes);
    }
  }
  const repoSize = 10 * 1024; // 10 KiB -> bytes

  return {
    repositorySizeBytes: repoSize,
    releaseSizeBytes: releaseSize,
    totalSizeBytes: repoSize + releaseSize,
    releaseCount: mappedReleases.length,
    assetCount,
    totalDownloadCount: downloads,
    largestAssetSizeBytes: largest,
    releases: mappedReleases,
    collectionStatus: "complete",
    error: null,
  };
}

describe("persistRepositoryStorage", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeAll(() => {
    db = createTestDb();
  });

  const userId = "user-1";
  const repoId = "repo-1";
  const configId = "config-1";

  test("complete scan writes state, assets and one snapshot", async () => {
    await persistRepositoryStorage(db, {
      userId,
      repositoryId: repoId,
      configId,
      outcome: {
        status: "complete",
        measure: makeMeasure([
          { id: 1, tag: "v1", assets: [{ id: 11, name: "a.zip", size: 100, downloads: 2 }, { id: 12, name: "b.zip", size: 900, downloads: 0 }] },
          { id: 2, tag: "v2", assets: [{ id: 21, name: "c.bin", size: 2000, downloads: 7 }] },
        ]),
      },
    });

    const [state] = db.select().from(storageStates).where(eq(storageStates.repositoryId, repoId)).all();
    expect(state.collectionStatus).toBe("complete");
    expect(state.releaseSizeBytes).toBe(3000);
    expect(state.totalSizeBytes).toBe(10 * 1024 + 3000);
    expect(state.largestAssetSizeBytes).toBe(2000);
    expect(state.totalDownloadCount).toBe(9);

    const assets = db.select().from(storageReleaseAssets).where(eq(storageReleaseAssets.repositoryId, repoId)).all();
    expect(assets.length).toBe(3);

    const snapshots = db.select().from(storageSnapshots).where(eq(storageSnapshots.repositoryId, repoId)).all();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].totalSizeBytes).toBe(10 * 1024 + 3000);
  });

  test("a later complete scan replaces current assets but never rewrites history", async () => {
    await persistRepositoryStorage(db, {
      userId,
      repositoryId: repoId,
      configId,
      outcome: {
        // release v1 and its assets were deleted on Gitea
        status: "complete",
        measure: makeMeasure([{ id: 2, tag: "v2", assets: [{ id: 21, name: "c.bin", size: 2500, downloads: 10 }] }]),
      },
    });

    const [state] = db.select().from(storageStates).where(eq(storageStates.repositoryId, repoId)).all();
    // still exactly one state row per repository (upsert, no duplicates)
    expect(db.select().from(storageStates).where(eq(storageStates.repositoryId, repoId)).all().length).toBe(1);
    expect(state.releaseSizeBytes).toBe(2500);
    expect(state.assetCount).toBe(1);

    const assets = db.select().from(storageReleaseAssets).where(eq(storageReleaseAssets.repositoryId, repoId)).all();
    expect(assets.length).toBe(1);
    expect(assets[0].sizeBytes).toBe(2500);

    const snapshots = db.select().from(storageSnapshots).where(eq(storageSnapshots.repositoryId, repoId)).all();
    expect(snapshots.length).toBe(2);
    const old = snapshots.find((s) => s.releaseSizeBytes === 3000);
    expect(old).toBeDefined(); // history untouched
  });

  test("partial scan keeps old numbers and only records the status", async () => {
    await persistRepositoryStorage(db, {
      userId,
      repositoryId: repoId,
      configId,
      outcome: {
        status: "partial",
        measure: {
          ...makeMeasure([]),
          releaseSizeBytes: 0,
          totalSizeBytes: 10 * 1024,
        },
      },
    });

    const [state] = db.select().from(storageStates).where(eq(storageStates.repositoryId, repoId)).all();
    expect(state.collectionStatus).toBe("partial");
    // must NOT collapse to the fake zero from the incomplete capture
    expect(state.totalSizeBytes).toBe(10 * 1024 + 2500);

    const assets = db.select().from(storageReleaseAssets).where(eq(storageReleaseAssets.repositoryId, repoId)).all();
    expect(assets.length).toBe(1);

    // no snapshot for an incomplete capture
    expect(db.select().from(storageSnapshots).where(eq(storageSnapshots.repositoryId, repoId)).all().length).toBe(2);
  });

  test("failed scan keeps old numbers and stores the error", async () => {
    await persistRepositoryStorage(db, {
      userId,
      repositoryId: repoId,
      configId,
      outcome: { status: "error", reason: "Gitea API request failed: HTTP 401 Unauthorized" },
    });

    const [state] = db.select().from(storageStates).where(eq(storageStates.repositoryId, repoId)).all();
    expect(state.collectionStatus).toBe("error");
    expect(state.lastError).toContain("401");
    expect(state.totalSizeBytes).toBe(10 * 1024 + 2500);
  });

  test("skipped destination (unsupported provider) records reason without zeroing data", async () => {
    await persistRepositoryStorage(db, {
      userId,
      repositoryId: repoId,
      configId,
      outcome: { status: "skipped", reason: 'Destination provider "github" does not expose the Gitea storage API' },
    });

    const [state] = db.select().from(storageStates).where(eq(storageStates.repositoryId, repoId)).all();
    expect(state.collectionStatus).toBe("error");
    expect(state.lastError).toContain("github");
    expect(state.totalSizeBytes).toBe(10 * 1024 + 2500);
  });
});
