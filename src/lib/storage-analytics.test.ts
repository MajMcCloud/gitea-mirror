import { describe, expect, test } from "bun:test";
import {
  aggregateSnapshotsByDay,
  computeGrowth,
  kibToBytes,
  matchesLowUsageFilter,
  projectGrowth,
  scanGiteaRepositoryStorage,
  type FetchLike,
} from "./storage-analytics";

const DAY = 24 * 60 * 60 * 1000;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeRelease(id: number, assetSize: number, downloadCount = 0) {
  return {
    id,
    tag_name: `v${id}`,
    name: `Release ${id}`,
    draft: false,
    prerelease: false,
    published_at: "2024-01-01T00:00:00Z",
    html_url: `http://gitea.local/releases/${id}`,
    assets: [
      {
        id: id * 10,
        name: `file-${id}.zip`,
        size: assetSize,
        download_count: downloadCount,
        browser_download_url: `http://gitea.local/asset/${id}`,
        created_at: "2024-01-01T00:00:00Z",
      },
    ],
  };
}

describe("kibToBytes", () => {
  test("converts KiB (Gitea's unit) to bytes", () => {
    expect(kibToBytes(1)).toBe(1024);
    expect(kibToBytes(1024)).toBe(1024 * 1024);
    expect(kibToBytes(0)).toBe(0);
  });

  test("rejects invalid values instead of silently producing garbage", () => {
    expect(kibToBytes(null)).toBeNull();
    expect(kibToBytes(undefined)).toBeNull();
    expect(kibToBytes("123")).toBeNull();
    expect(kibToBytes(-5)).toBeNull();
    expect(kibToBytes(Number.NaN)).toBeNull();
  });
});

describe("scanGiteaRepositoryStorage", () => {
  const base = "http://gitea.local";

  test("reads repo size in KiB and sums asset bytes", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/releases")) return jsonResponse([]);
      return jsonResponse({ id: 1, size: 1887436, html_url: `${base}/o/r`, updated_at: "2024-05-01T00:00:00Z" });
    };
    const result = await scanGiteaRepositoryStorage({
      baseUrl: base,
      token: "t",
      fullName: "o/r",
      fetchImpl,
    });
    // 1887436 KiB = 1.8 GiB
    expect(result.repositorySizeBytes).toBe(1887436 * 1024);
    expect(result.releaseSizeBytes).toBe(0);
    expect(result.totalSizeBytes).toBe(1887436 * 1024);
    expect(result.collectionStatus).toBe("complete");
  });

  test("a repo without releases is complete with release size 0", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/releases")) return jsonResponse([]);
      return jsonResponse({ size: 10 });
    };
    const result = await scanGiteaRepositoryStorage({ baseUrl: base, token: "t", fullName: "o/r", fetchImpl });
    expect(result.collectionStatus).toBe("complete");
    expect(result.releaseCount).toBe(0);
    expect(result.releaseSizeBytes).toBe(0);
    expect(result.error).toBeNull();
  });

  test("walks every release page instead of only the first", async () => {
    const pages = new Map<number, unknown[]>();
    const page1 = Array.from({ length: 50 }, (_, i) => makeRelease(i + 1, 100));
    const page2 = Array.from({ length: 50 }, (_, i) => makeRelease(i + 51, 200));
    const page3 = [makeRelease(101, 300)];
    pages.set(1, page1);
    pages.set(2, page2);
    pages.set(3, page3);

    const fetchImpl: FetchLike = async (url) => {
      if (!url.includes("/releases")) return jsonResponse({ id: 1, name: "r", full_name: "o/r", size: 10 });
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse(pages.get(page) ?? []);
    };

    const result = await scanGiteaRepositoryStorage({ baseUrl: base, token: "t", fullName: "o/r", fetchImpl });
    expect(result.releaseCount).toBe(101);
    expect(result.releaseSizeBytes).toBe(50 * 100 + 50 * 200 + 300);
    expect(result.collectionStatus).toBe("complete");
  });

  test("duplicate release ids across shifting pages are counted once", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (!url.includes("/releases")) return jsonResponse({ id: 1, name: "r", full_name: "o/r", size: 10 });
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 1) return jsonResponse(Array.from({ length: 50 }, (_, i) => makeRelease(i + 1, 100)));
      // server shifted: re-sends two of page one plus new entries
      return jsonResponse([makeRelease(49, 100), makeRelease(50, 100), makeRelease(51, 100)]);
    };
    const result = await scanGiteaRepositoryStorage({ baseUrl: base, token: "t", fullName: "o/r", fetchImpl });
    expect(result.releaseCount).toBe(51);
    expect(result.releaseSizeBytes).toBe(51 * 100);
  });

  test("a failing release page marks the scan partial and keeps what it has", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (!url.includes("/releases")) return jsonResponse({ size: 42 });
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 1) return jsonResponse(Array.from({ length: 50 }, (_, i) => makeRelease(i + 1, 100)));
      return new Response("boom", { status: 500 });
    };
    const result = await scanGiteaRepositoryStorage({ baseUrl: base, token: "t", fullName: "o/r", fetchImpl });
    expect(result.collectionStatus).toBe("partial");
    expect(result.error).toContain("Release page 2");
    // partial results must never be silently treated as complete
    expect(result.releaseCount).toBe(50);
    expect(result.releaseSizeBytes).toBe(50 * 100);
  });

  test("retries 429 and honors Retry-After", async () => {
    let repoCalls = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/releases")) return jsonResponse([]);
      repoCalls += 1;
      if (repoCalls === 1) {
        return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
      }
      return jsonResponse({ size: 7 });
    };
    const result = await scanGiteaRepositoryStorage({ baseUrl: base, token: "t", fullName: "o/r", fetchImpl });
    expect(repoCalls).toBe(2);
    expect(result.collectionStatus).toBe("complete");
    expect(result.repositorySizeBytes).toBe(7 * 1024);
  });

  test("missing or invalid repo size yields an error, not zero", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/releases")) return jsonResponse([]);
      return jsonResponse({ id: 1 });
    };
    const result = await scanGiteaRepositoryStorage({ baseUrl: base, token: "t", fullName: "o/r", fetchImpl });
    expect(result.collectionStatus).toBe("error");
    expect(result.error).toContain("size");
  });

  test("tracks downloads and largest asset", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/releases")) {
        return jsonResponse([makeRelease(1, 1000, 4), makeRelease(2, 9000, 0)]);
      }
      return jsonResponse({ size: 1 });
    };
    const result = await scanGiteaRepositoryStorage({ baseUrl: base, token: "t", fullName: "o/r", fetchImpl });
    expect(result.totalDownloadCount).toBe(4);
    expect(result.largestAssetSizeBytes).toBe(9000);
  });
});

describe("computeGrowth", () => {
  test("positive growth with percent and daily average", () => {
    const g = computeGrowth(
      { totalSizeBytes: 3000, capturedAt: new Date(Date.now()) },
      { totalSizeBytes: 1000, capturedAt: new Date(Date.now() - 10 * DAY) },
    );
    expect(g.deltaBytes).toBe(2000);
    expect(g.deltaPercent).toBeCloseTo(200);
    expect(g.days).toBeCloseTo(10);
    expect(g.avgBytesPerDay).toBeCloseTo(200);
  });

  test("negative values are allowed (deleted releases, gc)", () => {
    const g = computeGrowth(
      { totalSizeBytes: 500, capturedAt: new Date(Date.now()) },
      { totalSizeBytes: 1000, capturedAt: new Date(Date.now() - 5 * DAY) },
    );
    expect(g.deltaBytes).toBe(-500);
    expect(g.deltaPercent).toBeCloseTo(-50);
    expect(g.avgBytesPerDay).toBeCloseTo(-100);
  });

  test("percent is null when growing from zero", () => {
    const g = computeGrowth(
      { totalSizeBytes: 100, capturedAt: new Date(Date.now()) },
      { totalSizeBytes: 0, capturedAt: new Date(Date.now() - DAY) },
    );
    expect(g.deltaBytes).toBe(100);
    expect(g.deltaPercent).toBeNull();
  });
});

describe("aggregateSnapshotsByDay", () => {
  test("sums multiple captures of the same day and keeps day separation", () => {
    const day1 = new Date("2024-03-01T08:00:00Z");
    const day1b = new Date("2024-03-01T20:00:00Z");
    const day2 = new Date("2024-03-02T09:00:00Z");
    const series = aggregateSnapshotsByDay([
      { capturedAt: day1, repositorySizeBytes: 100, releaseSizeBytes: 10, totalSizeBytes: 110 },
      { capturedAt: day1b, repositorySizeBytes: 50, releaseSizeBytes: 5, totalSizeBytes: 55 },
      { capturedAt: day2, repositorySizeBytes: 200, releaseSizeBytes: 20, totalSizeBytes: 220 },
    ]);
    expect(series.length).toBe(2);
    expect(series[0].totalSizeBytes).toBe(165);
    expect(series[0].capturedAt.toISOString()).toBe("2024-03-01T00:00:00.000Z");
    expect(series[1].totalSizeBytes).toBe(220);
  });
});

describe("projectGrowth", () => {
  test("null when history is shorter than the minimum span", () => {
    const result = projectGrowth([
      { capturedAt: new Date(), totalSizeBytes: 1000 },
      { capturedAt: new Date(Date.now() + 2 * DAY), totalSizeBytes: 1200 },
    ]);
    expect(result).toBeNull();
  });

  test("projects from average daily growth over the full span", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-02-01T00:00:00Z"); // 31 days
    const result = projectGrowth([
      { capturedAt: start, totalSizeBytes: 1_000_000 },
      { capturedAt: end, totalSizeBytes: 1_031_000 },
    ]);
    expect(result).not.toBeNull();
    expect(result!.avgBytesPerDay).toBeCloseTo(1000, 0);
    const in30 = result!.projections.find((p) => p.days === 30);
    expect(in30).toBeDefined();
    expect(in30!.projectedBytes).toBeCloseTo(1_031_000 + 30_000, -1);
    // horizons far beyond the observed span are not extrapolated
    expect(result!.projections.find((p) => p.days === 365)).toBeUndefined();
  });
});

describe("matchesLowUsageFilter", () => {
  const now = new Date("2024-06-01T00:00:00Z");
  const MiB = 1024 * 1024;

  test("combines size, download and age thresholds", () => {
    const asset = {
      sizeBytes: 600 * MiB,
      downloadCount: 2,
      releasePublishedAt: new Date("2024-01-01T00:00:00Z"),
    };
    expect(matchesLowUsageFilter(asset, { minSizeBytes: 500 * MiB, maxDownloads: 9 }, now)).toBe(true);
    expect(matchesLowUsageFilter(asset, { maxDownloads: 1 }, now)).toBe(false);
    expect(matchesLowUsageFilter(asset, { minSizeBytes: 1024 * MiB }, now)).toBe(false);
    expect(matchesLowUsageFilter(asset, { olderThanDays: 90 }, now)).toBe(true);
    expect(matchesLowUsageFilter(asset, { olderThanDays: 365 }, now)).toBe(false);
  });

  test("age filter excludes assets without a publish date", () => {
    expect(
      matchesLowUsageFilter({ sizeBytes: 1, downloadCount: 0, releasePublishedAt: null }, { olderThanDays: 90 }, now),
    ).toBe(false);
  });
});
