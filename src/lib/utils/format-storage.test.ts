import { describe, expect, test } from "bun:test";
import { formatStorage, formatStorageBytes, formatPercent, formatCount } from "./format-storage";

describe("formatStorageBytes", () => {
  test("bytes below 1 KiB stay in B", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(512)).toBe("512 B");
    expect(formatStorageBytes(1023)).toBe("1023 B");
  });

  test("converts at binary 1024 boundaries", () => {
    expect(formatStorageBytes(1024)).toBe("1.0 KiB");
    expect(formatStorageBytes(1536)).toBe("1.5 KiB");
    expect(formatStorageBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(formatStorageBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GiB");
    expect(formatStorageBytes(1024 ** 4)).toBe("1.0 TiB");
  });

  test("drops decimals for large values", () => {
    // 150 GiB renders without fractional noise
    expect(formatStorageBytes(150 * 1024 ** 3)).toBe("150 GiB");
  });

  test("negative growth values keep their sign", () => {
    expect(formatStorageBytes(-1024)).toBe("-1.0 KiB");
    expect(formatStorageBytes(-2 * 1024 ** 3)).toBe("-2.0 GiB");
  });

  test("null/undefined render as zero", () => {
    expect(formatStorageBytes(null)).toBe("0 B");
    expect(formatStorageBytes(undefined)).toBe("0 B");
    expect(formatStorageBytes(Number.NaN)).toBe("0 B");
  });

  test("structured result exposes value and unit", () => {
    const formatted = formatStorage(2 * 1024 * 1024);
    expect(formatted.value).toBeCloseTo(2);
    expect(formatted.unit).toBe("MiB");
    expect(formatted.label).toBe("2.0 MiB");
  });
});

describe("formatPercent", () => {
  test("signs and rounding", () => {
    expect(formatPercent(5)).toBe("+5.0 %");
    expect(formatPercent(-50)).toBe("-50.0 %");
    expect(formatPercent(0)).toBe("0.0 %");
    expect(formatPercent(null)).toBe("–");
  });
});

describe("formatCount", () => {
  test("rounds and separates thousands", () => {
    expect(formatCount(1234.6)).toBe("1,235");
    expect(formatCount(null)).toBe("–");
  });
});
