import { describe, expect, it } from 'vitest';
import { formatAppointment, toLocalInput, zonedToUtc } from '../lib/time';

const iso = (local: string, timeZone = 'America/Toronto') => {
  const result = zonedToUtc(local, timeZone);
  return result.ok ? result.date.toISOString() : result.reason;
};

describe('zonedToUtc', () => {
  it('reads a winter time in Toronto (UTC-5)', () => {
    expect(iso('2026-12-01T14:00')).toBe('2026-12-01T19:00:00.000Z');
  });

  it('reads a summer time in Toronto (UTC-4)', () => {
    expect(iso('2026-07-01T14:00')).toBe('2026-07-01T18:00:00.000Z');
  });

  it('reads a time in Regina (UTC-6 all year)', () => {
    expect(iso('2026-12-01T09:30', 'America/Regina')).toBe('2026-12-01T15:30:00.000Z');
  });

  it('handles the day clocks go back', () => {
    // 2026-11-01: Toronto leaves daylight time at 02:00. Noon that day is EST.
    expect(iso('2026-11-01T12:00')).toBe('2026-11-01T17:00:00.000Z');
  });

  it('handles the day clocks go forward', () => {
    // 2026-03-08: Toronto enters daylight time at 02:00. Noon that day is EDT.
    expect(iso('2026-03-08T12:00')).toBe('2026-03-08T16:00:00.000Z');
    expect(iso('2026-03-08T01:59')).toBe('2026-03-08T06:59:00.000Z');
    expect(iso('2026-03-08T03:00')).toBe('2026-03-08T07:00:00.000Z');
  });

  it('refuses a time skipped when the clocks go forward', () => {
    // 2026-03-08 in Toronto: 02:00 EST jumps to 03:00 EDT, so 02:30 never happens.
    expect(zonedToUtc('2026-03-08T02:30', 'America/Toronto')).toEqual({ ok: false, reason: 'skipped' });
  });

  it('takes the earlier of a time that happens twice when the clocks go back', () => {
    // 2026-11-01 in Toronto: 01:30 EDT (05:30 UTC), then 01:30 EST (06:30 UTC).
    expect(iso('2026-11-01T01:30')).toBe('2026-11-01T05:30:00.000Z');
  });

  it.each(['', '2026-12-01', '2026-12-01 14:00', '2026-02-30T10:00', '2026-12-01T24:00', '2026-12-01T10:60', 'tomorrow'])(
    'refuses %j',
    (input) => {
      expect(zonedToUtc(input, 'America/Toronto')).toEqual({ ok: false, reason: 'invalid' });
    },
  );

  it('round-trips with toLocalInput', () => {
    const d = new Date('2026-12-01T19:00:00.000Z');
    expect(toLocalInput(d, 'America/Toronto')).toBe('2026-12-01T14:00');
    expect(iso(toLocalInput(d, 'America/Halifax'), 'America/Halifax')).toBe(d.toISOString());
  });
});

describe('formatAppointment', () => {
  it('formats in the business time zone, in plain ASCII so the text stays GSM-7', () => {
    const text = formatAppointment(new Date('2026-12-01T19:00:00.000Z'), 'America/Toronto');
    expect(text).toMatch(/Dec/);
    expect(text).toMatch(/2:00/);
    expect(text).toMatch(/^[\x20-\x7e]+$/);
  });
});
