/**
 * Appointments are booked in the business's time zone (BUSINESS_TIMEZONE),
 * whatever zone the customer's browser is in. These helpers convert between
 * that wall-clock time and real instants without a date library.
 */

function partsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** How far timeZone is ahead of UTC at this instant, in milliseconds. */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The value <input type="datetime-local"> uses for this instant in timeZone: "2026-11-18T14:00". */
export function toLocalInput(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export type ZonedTime =
  | { ok: true; date: Date }
  /** invalid: not a real date and time. skipped: the clocks jumped over it. */
  | { ok: false; reason: 'invalid' | 'skipped' };

const DAY = 24 * 60 * 60 * 1000;

/**
 * "2026-11-18T14:00" (what <input type="datetime-local"> sends), read as a
 * time in timeZone.
 */
export function zonedToUtc(local: string, timeZone: string): ZonedTime {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return { ok: false, reason: 'invalid' };
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC rolls Feb 30 over to Mar 2, so a time that doesn't come back unchanged was never real.
  if (new Date(wall).toISOString().slice(0, 16) !== local) return { ok: false, reason: 'invalid' };

  // Try the zone's offset from a day before and a day after. They differ only
  // around a DST change. Keep each guess that reads back as the same wall time.
  const matches = [offsetMs(new Date(wall - DAY), timeZone), offsetMs(new Date(wall + DAY), timeZone)]
    .map((offset) => wall - offset)
    .filter((utc) => toLocalInput(new Date(utc), timeZone) === local);

  // None: the clocks went forward past it (2:30 a.m. on a spring-forward night never happens).
  if (matches.length === 0) return { ok: false, reason: 'skipped' };
  // Two: the clocks went back and the time happened twice (1:30 a.m. on a
  // fall-back night). Take the earlier one, the first time the clock shows it.
  return { ok: true, date: new Date(Math.min(...matches)) };
}

/**
 * "Tue, Nov 18, 2:00 p.m." in timeZone, in plain ASCII. ICU puts a narrow
 * no-break space before "p.m.", and one character outside the GSM-7 set makes
 * the carrier encode the whole text as Unicode: 70 characters a segment
 * instead of 160, so a reminder could cost two or three segments.
 */
export function formatAppointment(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(date)
    .replace(/[   ]/g, ' ');
}
