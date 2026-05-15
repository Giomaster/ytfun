export function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function ageHours(isoDate: string): number {
  const ageMs = Date.now() - new Date(isoDate).getTime();
  return Math.max(ageMs / 3_600_000, 1);
}

export function parseDurationToSeconds(value: string): number {
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  const clock = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const first = Number(clock[1]);
    const second = Number(clock[2]);
    const third = clock[3] ? Number(clock[3]) : undefined;
    return third === undefined ? first * 60 + second : first * 3600 + second * 60 + third;
  }

  const iso = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (iso) {
    return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  }

  throw new Error(`Unsupported duration format: ${value}`);
}
