export type SessionTimeDisplay = { iso: string; relative: string; exact: string };
export type SessionTimeFormatter = (value: unknown, now?: number) => SessionTimeDisplay | undefined;

export function createSessionTimeFormatter(): SessionTimeFormatter {
  const zonedDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
  const datePartsFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", calendar: "iso8601", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const exactFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "medium", hourCycle: "h23",
  });
  const jstDayNumber = (date: Date) => {
    const parts = new Map(datePartsFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
    const day = new Date(0);
    day.setUTCFullYear(Number(parts.get("year")), Number(parts.get("month")) - 1, Number(parts.get("day")));
    day.setUTCHours(0, 0, 0, 0);
    return day.getTime() / 86_400_000;
  };
  return (value, now = Date.now()) => {
    if (typeof value !== "string" || !zonedDatePattern.test(value)) return undefined;
    const dateOnly = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(dateOnly.getTime()) || dateOnly.toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
    const date = new Date(value);
    const nowDate = new Date(now);
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(nowDate.getTime())) return undefined;

    const elapsed = date.getTime() - nowDate.getTime();
    const elapsedMagnitude = Math.abs(elapsed);
    const dayDifference = jstDayNumber(date) - jstDayNumber(nowDate);
    const suffix = elapsed < 0 ? "前" : "後";
    let relative: string;

    if (elapsedMagnitude < 60_000) relative = "たった今";
    else if (dayDifference === -1) relative = "昨日";
    else if (dayDifference === 1) relative = "明日";
    else if (dayDifference < -1) relative = `${Math.abs(dayDifference)}日前`;
    else if (dayDifference > 1) relative = `${dayDifference}日後`;
    else if (elapsedMagnitude < 3_600_000) relative = `${Math.floor(elapsedMagnitude / 60_000)}分${suffix}`;
    else relative = `${Math.floor(elapsedMagnitude / 3_600_000)}時間${suffix}`;

    return { iso: date.toISOString(), relative, exact: `${exactFormatter.format(date)} JST` };
  };
}

export const formatSessionTime = createSessionTimeFormatter();
