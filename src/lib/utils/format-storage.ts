export interface FormattedStorage {
  value: number;
  unit: string;
  label: string;
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

// Binary units (1024), matching how Gitea reports repository sizes (KiB).
export function formatStorage(bytes: number | null | undefined, fractionDigits = 1): FormattedStorage {
  const value = Number.isFinite(bytes as number) ? (bytes as number) : 0;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  if (abs < 1024) {
    return { value: abs, unit: "B", label: `${sign}${abs} B` };
  }

  let unitIndex = 0;
  let scaled = abs;
  while (scaled >= 1024 && unitIndex < UNITS.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  const digits = scaled >= 100 ? 0 : fractionDigits;
  const label = `${sign}${scaled.toFixed(digits)} ${UNITS[unitIndex]}`;
  return { value: scaled, unit: UNITS[unitIndex], label };
}

export function formatStorageBytes(bytes: number | null | undefined, fractionDigits = 1): string {
  return formatStorage(bytes, fractionDigits).label;
}

export function formatPercent(value: number | null | undefined, fractionDigits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "–";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(fractionDigits)} %`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "–";
  }
  return Math.round(value).toLocaleString("en-US");
}
