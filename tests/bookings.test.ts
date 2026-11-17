import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonkioError } from '@honkio/node';
import {
  bookAppointment,
  cancelAppointment,
  confirmBookingPhone,
  confirmationText,
  consentSource,
  parseBookingForm,
  planReminder,
  reminderText,
  resendBookingCode,
  type Limits,
  type SmsClient,
} from '../lib/bookings';
import type { Business } from '../lib/config';
import { RateLimiter } from '../lib/rateLimit';
import { JsonFileStore } from '../lib/store';

const business: Business = {
  name: 'Acme Clinic',
  contact: '100 King St W, Toronto ON, hello@example.com',
  timeZone: 'America/Toronto',
  reminderHoursBefore: 24,
};
const FROM = '+16135550100';
const NOW = new Date('2026-11-17T15:00:00.000Z');
const STARTS = new Date('2026-11-20T19:00:00.000Z'); // 2 pm Toronto, three days out

const apiError = (name: string, statusCode: number | null, details?: unknown): HonkioError =>
  ({ name, message: `${name} from the API`, statusCode, details }) as HonkioError;

// A stand-in for the SDK client: messages.send/cancel, consents.create and verify.start/check as vi.fn()s.
function fakeClient() {
  const send = vi.fn();
  const cancel = vi.fn();
  const createConsent = vi.fn();
  const startCode = vi.fn();
  const checkCode = vi.fn();
  const client = {
    messages: { send, cancel },
    consents: { create: createConsent },
    verify: { start: startCode, check: checkCode },
  } as unknown as SmsClient;
  return { client, send, cancel, createConsent, startCode, checkCode };
}

/** Limits for a test: one count for every limit unless given. */
function limitsOf(n: { perIp?: number; textsPerPhoneAndIp?: number; textsPerPhone?: number; codesPerPhoneAndIp?: number; codesPerPhone?: number }): Limits {
  const limiter = (limit = 100) => new RateLimiter(limit, 86_400_000);
  return {
    perIp: limiter(n.perIp),
    texts: { perPhoneAndIp: limiter(n.textsPerPhoneAndIp), perPhone: limiter(n.textsPerPhone) },
    codes: { perPhoneAndIp: limiter(n.codesPerPhoneAndIp), perPhone: limiter(n.codesPerPhone) },
  };
}

let dir: string;
let store: JsonFileStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookings-'));
  store = new JsonFileStore(join(dir, 'bookings.json'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const TOKEN = '6f1c2a8e-3b4d-4e5f-9a0b-1c2d3e4f5a6b';
const input = { formToken: TOKEN, name: 'Ada', phone: '+16135550123', startsAt: STARTS, smsOptIn: true };

const recorded = { data: { status: 'recorded', phone_number: input.phone, expires_at: null }, error: null };
const sent = (id: string, extra: object = {}) => ({ data: { id, status: 'QUEUED', ...extra }, error: null });
const scheduled = sent('msg_remind', { status: 'SCHEDULED', scheduled_at: '2026-11-19T19:00:00.000Z' });
const codeSent = (id = 'ver_1') => ({ data: { id, mode: 'TEST', test_code: '000000', phone_number: input.phone }, error: null });
const codeOk = { data: { id: 'ver_1', status: 'verified', phone_number: input.phone }, error: null };

/** Makes the fake client accept consent and every send, as a working live account would. */
function acceptEverything(f: ReturnType<typeof fakeClient>) {
  f.createConsent.mockResolvedValue(recorded);
  f.send.mockImplementation(async (body: { scheduledAt?: Date }) => (body.scheduledAt ? scheduled : sent('msg_confirm')));
  f.startCode.mockResolvedValue(codeSent());
  f.checkCode.mockResolvedValue(codeOk);
}

describe('planReminder', () => {
  it('schedules the reminder hoursBefore the appointment, expiring at the appointment', () => {
    const plan = planReminder(STARTS, NOW, 24);
    expect(plan).toEqual({
      kind: 'scheduled',
      scheduledAt: new Date('2026-11-19T19:00:00.000Z'),
      expiresAt: new Date('2026-11-20T19:00:00.000Z'),
    });
  });

  it('caps expiresAt at 24 hours after scheduledAt, the most HonkIO allows', () => {
    const plan = planReminder(STARTS, NOW, 48);
    expect(plan).toMatchObject({ kind: 'scheduled', expiresAt: new Date('2026-11-19T19:00:00.000Z') });
  });

  it('skips a reminder that would be due in under five minutes', () => {
    expect(planReminder(new Date(NOW.getTime() + 2 * 3_600_000), NOW, 2)).toEqual({ kind: 'too_soon' });
  });
});

describe('parseBookingForm', () => {
  const form = { formToken: TOKEN, name: ' Ada ', phone: '(613) 555-0123', startsAt: '2026-11-20T14:00', smsOptIn: 'on' };

  it('reads the form in the business time zone', () => {
    expect(parseBookingForm(form, business, NOW)).toEqual({
      ok: true,
      input: { formToken: TOKEN, name: 'Ada', phone: '+16135550123', startsAt: STARTS, smsOptIn: true },
    });
  });

  it('refuses a missing or made-up form token', () => {
    for (const formToken of [undefined, '', 'abc', '../../etc/passwd']) {
      expect(parseBookingForm({ ...form, formToken }, business, NOW)).toEqual({
        ok: false,
        error: 'This form is out of date. Reload the page and try again.',
      });
    }
  });

  it('explains a time the clocks skip, and books the earlier of a time that happens twice', () => {
    const springNow = new Date('2026-03-01T15:00:00.000Z');
    expect(parseBookingForm({ ...form, startsAt: '2026-03-08T02:30' }, business, springNow)).toEqual({
      ok: false,
      error: 'That time doesn’t exist: the clocks go forward an hour that night. Pick another time.',
    });
    const fallNow = new Date('2026-10-25T15:00:00.000Z');
    expect(parseBookingForm({ ...form, startsAt: '2026-11-01T01:30' }, business, fallNow)).toMatchObject({
      ok: true,
      input: { startsAt: new Date('2026-11-01T05:30:00.000Z') },
    });
  });

  it('treats a missing checkbox as no consent', () => {
    const result = parseBookingForm({ ...form, smsOptIn: null }, business, NOW);
    expect(result).toMatchObject({ ok: true, input: { smsOptIn: false } });
  });

  it('refuses a time in the past and one beyond the 30-day scheduling window', () => {
    expect(parseBookingForm({ ...form, startsAt: '2026-11-16T14:00' }, business, NOW)).toMatchObject({ ok: false });
    expect(parseBookingForm({ ...form, startsAt: '2026-12-20T14:00' }, business, NOW)).toEqual({
      ok: false,
      error: 'Appointments can be booked up to 30 days ahead.',
    });
  });

  it('refuses a bad phone number', () => {
    expect(parseBookingForm({ ...form, phone: '12345' }, business, NOW)).toMatchObject({ ok: false });
  });
});

describe('message text', () => {
  it('keeps every text in plain ASCII and names the business', () => {
    for (const text of [confirmationText(business, STARTS, true), reminderText(business, STARTS)]) {
      expect(text).toMatch(/^Acme Clinic/);
      expect(text).toMatch(/Reply STOP to opt out\.$/);
      expect(text).toMatch(/^[\x20-\x7e]+$/);
      expect(text.length).toBeLessThanOrEqual(160);
    }
  });
});

describe('consentSource', () => {
  it('says only what the form shows, quotes the box and includes the contact line shown with it', () => {
    const text = consentSource(business, 'bk_1');
    expect(text).toContain('The person booking ticked the unticked SMS opt-in box');
    expect(text).toContain('for the mobile number they entered (booking bk_1)');
    expect(text).toContain(`Box text: "Text me a confirmation and a reminder about this appointment from Acme Clinic.`);
    expect(text).toContain('Shown with the box: "Acme Clinic, 100 King St W, Toronto ON, hello@example.com"');
    expect(text.length).toBeLessThanOrEqual(1000); // HonkIO keeps up to 1000 characters
    expect(text).not.toContain('code');
  });

  it('says the number was confirmed with a code when it was', () => {
    const text = consentSource(business, 'bk_1', true);
    expect(text).toContain('(booking bk_1), then confirmed the number by entering a one-time code texted to it.');
    expect(text.length).toBeLessThanOrEqual(1000);
  });
});

describe('bookAppointment', () => {
  const deps = (client: SmsClient, extra: object = {}) => ({ client, store, business, from: FROM, policy: 'send' as const, now: () => NOW, ...extra });

  it('records consent, schedules the reminder, then texts a confirmation that mentions it', async () => {
    const { client, send, createConsent } = fakeClient();
    createConsent.mockResolvedValue(recorded);
    send.mockResolvedValueOnce(scheduled).mockResolvedValueOnce(sent('msg_confirm'));

    const result = await bookAppointment(deps(client), input, { ip: '203.0.113.7', url: 'https://book.example.com/' });
    if (!result.ok) throw new Error(result.error);
    const { booking } = result;

    expect(createConsent).toHaveBeenCalledWith({
      phoneNumber: '+16135550123',
      consentType: 'express',
      sourceDescription: consentSource(business, booking.id),
      sourceIp: '203.0.113.7',
      sourceUrl: 'https://book.example.com/',
    });

    expect(send).toHaveBeenNthCalledWith(
      1,
      {
        from: FROM,
        to: '+16135550123',
        body: reminderText(business, STARTS),
        scheduledAt: new Date('2026-11-19T19:00:00.000Z'),
        expiresAt: STARTS,
      },
      { idempotencyKey: `booking-${booking.id}-reminder` },
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      { from: FROM, to: '+16135550123', body: confirmationText(business, STARTS, true) },
      { idempotencyKey: `booking-${booking.id}-confirmation` },
    );
    expect(confirmationText(business, STARTS, true)).toMatch(/reminder 1 day before/);
    // Consent is recorded before the first text goes out.
    expect(createConsent.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);

    expect(booking).toMatchObject({
      formToken: TOKEN,
      status: 'booked',
      confirmationMessageId: 'msg_confirm',
      reminderMessageId: 'msg_remind',
      reminderAt: '2026-11-19T19:00:00.000Z',
      smsNote: null,
    });
    expect(await store.get(booking.id)).toEqual(booking);
  });

  it('sends the consent record no IP or URL when it has none', async () => {
    const { client, send, createConsent } = fakeClient();
    createConsent.mockResolvedValue(recorded);
    send.mockResolvedValueOnce(scheduled).mockResolvedValueOnce(sent('msg_confirm'));

    await bookAppointment(deps(client), input);
    expect(createConsent.mock.calls[0]![0]).not.toHaveProperty('sourceIp');
    expect(createConsent.mock.calls[0]![0]).not.toHaveProperty('sourceUrl');
  });

  it('confirms without promising a reminder when the reminder could not be scheduled', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, send, createConsent } = fakeClient();
    createConsent.mockResolvedValue(recorded);
    send
      .mockResolvedValueOnce({ data: null, error: apiError('SCHEDULED_LIMIT_REACHED', 429) })
      .mockResolvedValueOnce(sent('msg_confirm'));

    const result = await bookAppointment(deps(client), input);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].body).toBe(confirmationText(business, STARTS, false));
    expect(send.mock.calls[1]![0].body).not.toMatch(/reminder/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SCHEDULED_LIMIT_REACHED'));
    expect(result).toMatchObject({
      ok: true,
      booking: { confirmationMessageId: 'msg_confirm', reminderMessageId: null, reminderAt: null, smsNote: null },
    });
  });

  it('sends nothing and records no consent when the box was not ticked', async () => {
    const { client, send, createConsent } = fakeClient();
    const result = await bookAppointment(deps(client), { ...input, smsOptIn: false });

    expect(createConsent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, booking: { status: 'booked', smsOptIn: false, confirmationMessageId: null } });
  });

  it('returns the first booking and sends nothing new when the same form is sent twice', async () => {
    const { client, send, createConsent } = fakeClient();
    createConsent.mockResolvedValue(recorded);
    send.mockResolvedValueOnce(scheduled).mockResolvedValueOnce(sent('msg_confirm'));

    const first = await bookAppointment(deps(client), input);
    const second = await bookAppointment(deps(client), input);

    expect(second).toEqual(first);
    expect(createConsent).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('makes one booking when two submits of the same form race, and both use its idempotency keys', async () => {
    const { client, send, createConsent } = fakeClient();
    createConsent.mockResolvedValue(recorded);
    send.mockImplementation(async (body: { scheduledAt?: Date }) => (body.scheduledAt ? scheduled : sent('msg_confirm')));

    const [a, b] = await Promise.all([bookAppointment(deps(client), input), bookAppointment(deps(client), input)]);
    if (!a.ok || !b.ok) throw new Error('booking failed');

    expect(a.booking.id).toBe(b.booking.id);
    const keys = send.mock.calls.map((call) => call[1].idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`booking-${a.booking.id}-reminder`, `booking-${a.booking.id}-confirmation`]));
  });

  it('limits bookings per IP, and skips the per-IP limit when there is no IP', async () => {
    const { client } = fakeClient();
    const limits = limitsOf({ perIp: 1 });
    const book = (n: number, ip?: string) =>
      bookAppointment(deps(client, { limits }), { ...input, formToken: TOKEN.replace(/.$/, String(n)), smsOptIn: false }, { ip });

    expect(await book(1, '203.0.113.7')).toMatchObject({ ok: true });
    expect(await book(2, '203.0.113.7')).toEqual({ ok: false, error: 'Too many bookings from your connection. Please try again later.' });
    expect(await book(3, '203.0.113.8')).toMatchObject({ ok: true });
    expect(await book(4)).toMatchObject({ ok: true });
    expect(await book(5)).toMatchObject({ ok: true });
  });

  it('limits text bookings per number from one IP, so a stranger can’t use up yours', async () => {
    const f = fakeClient();
    acceptEverything(f);
    const limits = limitsOf({ textsPerPhoneAndIp: 2 });
    const book = (n: number, ip: string) =>
      bookAppointment(deps(f.client, { limits }), { ...input, formToken: TOKEN.replace(/.$/, String(n)) }, { ip });

    expect(await book(1, '203.0.113.66')).toMatchObject({ ok: true });
    expect(await book(2, '203.0.113.66')).toMatchObject({ ok: true });
    expect(await book(3, '203.0.113.66')).toEqual({ ok: false, error: 'Too many bookings for this number today. Please try again tomorrow.' });
    // The number's owner, on their own connection, still books with texts.
    expect(await book(4, '203.0.113.7')).toMatchObject({ ok: true, booking: { confirmationMessageId: 'msg_confirm' } });
  });

  it('caps text bookings per number across all IPs, as a backstop', async () => {
    const f = fakeClient();
    acceptEverything(f);
    const limits = limitsOf({ textsPerPhone: 3 });
    const book = (n: number, phone = input.phone) =>
      bookAppointment(deps(f.client, { limits }), { ...input, phone, formToken: TOKEN.replace(/.$/, String(n)) }, { ip: `203.0.113.${n}` });

    for (const n of [1, 2, 3]) expect(await book(n)).toMatchObject({ ok: true });
    expect(await book(4)).toEqual({ ok: false, error: 'Too many bookings for this number today. Please try again tomorrow.' });
    expect(await book(5, '+16135550199')).toMatchObject({ ok: true });
  });

  it('counts only bookings that ask for texts against the number', async () => {
    const f = fakeClient();
    acceptEverything(f);
    const limits = limitsOf({ textsPerPhoneAndIp: 1, textsPerPhone: 1 });
    const book = (n: number, smsOptIn: boolean) =>
      bookAppointment(deps(f.client, { limits }), { ...input, smsOptIn, formToken: TOKEN.replace(/.$/, String(n)) }, { ip: '203.0.113.7' });

    for (const n of [1, 2, 3]) expect(await book(n, false)).toMatchObject({ ok: true });
    expect(await book(4, true)).toMatchObject({ ok: true, booking: { confirmationMessageId: 'msg_confirm' } });
    expect(await book(5, true)).toMatchObject({ ok: false });
  });

  it('does not count a resubmit of the same form against the limits', async () => {
    const { client } = fakeClient();
    const limits = limitsOf({ perIp: 1, textsPerPhoneAndIp: 1, textsPerPhone: 1 });
    const first = await bookAppointment(deps(client, { limits }), { ...input, smsOptIn: false }, { ip: '203.0.113.7' });
    const again = await bookAppointment(deps(client, { limits }), { ...input, smsOptIn: false }, { ip: '203.0.113.7' });
    expect(again).toEqual(first);
  });

  it('keeps the booking and explains START when the number opted out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, send, createConsent } = fakeClient();
    createConsent.mockResolvedValue(recorded);
    send.mockResolvedValue({ data: null, error: apiError('OPT_OUT_BLOCKED', 451) });

    const result = await bookAppointment(deps(client), input);

    expect(result.ok && result.booking.status).toBe('booked');
    expect(result.ok && result.booking.smsNote).toMatch(/Text START to \(613\) 555-0100/);
  });

  it('keeps the booking and logs account problems for the owner', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, send, createConsent } = fakeClient();
    createConsent.mockResolvedValue(recorded);
    send.mockResolvedValue({ data: null, error: apiError('INSUFFICIENT_BALANCE', 402) });

    const result = await bookAppointment(deps(client), input);

    expect(result.ok && result.booking.smsNote).toBe('Your booking is saved, but we couldn’t send texts about it right now.');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('INSUFFICIENT_BALANCE'));
  });

  it('treats a consent VALIDATION_ERROR as the owner’s problem, not the customer’s number', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, send, createConsent } = fakeClient();
    createConsent.mockResolvedValue({ data: null, error: apiError('VALIDATION_ERROR', 422) });

    const result = await bookAppointment(deps(client), input);

    expect(send).not.toHaveBeenCalled();
    expect(result.ok && result.booking.smsNote).toBe('Your booking is saved, but we couldn’t send texts about it right now.');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('consents.create failed: VALIDATION_ERROR'));
  });

  it('only confirms when the appointment is too close for a reminder', async () => {
    const { client, send, createConsent } = fakeClient();
    createConsent.mockResolvedValue(recorded);
    send.mockResolvedValue(sent('msg_confirm'));
    const soon = new Date(NOW.getTime() + 3 * 3_600_000);

    const result = await bookAppointment(deps(client), { ...input, startsAt: soon });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].body).not.toMatch(/reminder/);
    expect(result).toMatchObject({ ok: true, booking: { confirmationMessageId: 'msg_confirm', reminderMessageId: null } });
  });
});

describe('texts in production without CONFIRM_PHONE (policy refuse)', () => {
  it('saves the booking, texts nothing, records no consent and tells the owner why', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeClient();
    const deps = { client: f.client, store, business, from: FROM, policy: 'refuse' as const, now: () => NOW };

    const result = await bookAppointment(deps, input, { ip: '203.0.113.7' });

    expect(result).toMatchObject({
      ok: true,
      booking: { status: 'booked', smsNote: 'Your booking is saved, but we couldn’t send texts about it right now.' },
    });
    expect(f.createConsent).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.startCode).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/CONFIRM_PHONE=true.*ALLOW_UNCONFIRMED_BOOKINGS=true/));
  });
});

describe('confirming the number first (CONFIRM_PHONE=true)', () => {
  const deps = (client: SmsClient, limits?: Limits) => ({ client, store, business, from: FROM, policy: 'confirm' as const, now: () => NOW, limits });
  const tokenFor = (n: number) => TOKEN.replace(/.$/, String(n));

  it('texts a code and nothing else until it is entered', async () => {
    const f = fakeClient();
    acceptEverything(f);

    const result = await bookAppointment(deps(f.client), input, { ip: '203.0.113.7' });

    expect(f.startCode).toHaveBeenCalledWith({ to: '+16135550123', from: FROM, appName: 'Acme Clinic' });
    expect(f.createConsent).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, booking: { verificationId: 'ver_1', testCode: '000000', confirmationMessageId: null, smsNote: null } });
  });

  it('records consent, saying the number was confirmed, and sends the texts once the code checks out', async () => {
    const f = fakeClient();
    acceptEverything(f);
    const booked = await bookAppointment(deps(f.client), input);
    if (!booked.ok) throw new Error(booked.error);

    const result = await confirmBookingPhone(deps(f.client), booked.booking.id, ' 000 000 ', { ip: '203.0.113.7', url: 'https://book.example.com/' });

    expect(f.checkCode).toHaveBeenCalledWith('ver_1', { code: '000000' });
    expect(f.createConsent).toHaveBeenCalledWith({
      phoneNumber: '+16135550123',
      consentType: 'express',
      sourceDescription: consentSource(business, booked.booking.id, true),
      sourceIp: '203.0.113.7',
      sourceUrl: 'https://book.example.com/',
    });
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      booking: { verificationId: null, testCode: null, confirmationMessageId: 'msg_confirm', reminderMessageId: 'msg_remind', smsNote: null },
    });
  });

  it('sends nothing on a wrong code, and keeps the code step', async () => {
    const f = fakeClient();
    acceptEverything(f);
    f.checkCode.mockResolvedValue({ data: null, error: apiError('VERIFICATION_INVALID_CODE', 422, { attempts_remaining: 4 }) });
    const booked = await bookAppointment(deps(f.client), input);
    if (!booked.ok) throw new Error(booked.error);

    const result = await confirmBookingPhone(deps(f.client), booked.booking.id, '123456');

    expect(result).toEqual({ ok: false, error: 'That code isn’t right. 4 tries left.' });
    expect(f.createConsent).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect((await store.get(booked.booking.id))?.verificationId).toBe('ver_1');
  });

  it('refuses a code that is not digits without calling the API, and a booking with no code waiting', async () => {
    const f = fakeClient();
    acceptEverything(f);
    const booked = await bookAppointment(deps(f.client), input);
    if (!booked.ok) throw new Error(booked.error);
    const unconfirmed = await bookAppointment({ ...deps(f.client), policy: 'send' }, { ...input, formToken: tokenFor(2) });
    if (!unconfirmed.ok) throw new Error(unconfirmed.error);

    expect(await confirmBookingPhone(deps(f.client), booked.booking.id, 'abc')).toEqual({ ok: false, error: 'Enter the code from the text, digits only.' });
    expect(await confirmBookingPhone(deps(f.client), unconfirmed.booking.id, '000000')).toEqual({
      ok: false,
      error: 'There’s no code to enter for this booking.',
    });
    expect(await confirmBookingPhone(deps(f.client), 'no-such-booking', '000000')).toMatchObject({ ok: false });
    expect(f.checkCode).not.toHaveBeenCalled();
  });

  it('keeps the booking with a note when the code could not be sent', async () => {
    const f = fakeClient();
    f.startCode.mockResolvedValue({ data: null, error: apiError('NOT_A_MOBILE_NUMBER', 422) });

    const result = await bookAppointment(deps(f.client), input);

    expect(result).toMatchObject({
      ok: true,
      booking: { status: 'booked', verificationId: null, smsNote: 'That number can’t receive texts, so we won’t text you about this booking.' },
    });
  });

  it('counts the booking against the number only once the code checks out', async () => {
    const f = fakeClient();
    acceptEverything(f);
    const limits = limitsOf({ textsPerPhoneAndIp: 1, textsPerPhone: 1 });
    const ids: string[] = [];
    // Three unconfirmed bookings for one number: none of them uses up its text allowance.
    for (const n of [1, 2, 3]) {
      const r = await bookAppointment(deps(f.client, limits), { ...input, formToken: tokenFor(n) }, { ip: `203.0.113.${n}` });
      if (!r.ok) throw new Error(r.error);
      ids.push(r.booking.id);
    }

    expect(await confirmBookingPhone(deps(f.client, limits), ids[0]!, '000000', { ip: '203.0.113.7' })).toMatchObject({
      ok: true,
      booking: { confirmationMessageId: 'msg_confirm' },
    });
    expect(await confirmBookingPhone(deps(f.client, limits), ids[1]!, '000000', { ip: '203.0.113.7' })).toMatchObject({
      ok: true,
      booking: { confirmationMessageId: null, smsNote: 'This number has had too many bookings today, so we won’t text you about this one.' },
    });
  });

  it('limits codes per number from one IP and per number in all', async () => {
    const f = fakeClient();
    acceptEverything(f);
    const limits = limitsOf({ codesPerPhoneAndIp: 1, codesPerPhone: 2 });
    const book = (n: number, ip: string) => bookAppointment(deps(f.client, limits), { ...input, formToken: tokenFor(n) }, { ip });
    const tooMany = { ok: false, error: 'Too many codes sent to this number. Please try again later, or book without texts.' };

    expect(await book(1, '203.0.113.66')).toMatchObject({ ok: true });
    expect(await book(2, '203.0.113.66')).toEqual(tooMany);
    expect(await book(3, '203.0.113.7')).toMatchObject({ ok: true });
    expect(await book(4, '203.0.113.8')).toEqual(tooMany);
    expect(f.startCode).toHaveBeenCalledTimes(2);
  });

  it('texts a new code on request, within the code limits', async () => {
    const f = fakeClient();
    acceptEverything(f);
    const limits = limitsOf({ codesPerPhoneAndIp: 2 });
    const booked = await bookAppointment(deps(f.client, limits), input, { ip: '203.0.113.7' });
    if (!booked.ok) throw new Error(booked.error);
    f.startCode.mockResolvedValue(codeSent('ver_2'));

    expect(await resendBookingCode(deps(f.client, limits), booked.booking.id, { ip: '203.0.113.7' })).toMatchObject({
      ok: true,
      booking: { verificationId: 'ver_2' },
    });
    expect(await resendBookingCode(deps(f.client, limits), booked.booking.id, { ip: '203.0.113.7' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Too many codes/),
    });
  });

  it('passes on HonkIO’s one code a minute', async () => {
    const f = fakeClient();
    acceptEverything(f);
    const booked = await bookAppointment(deps(f.client), input);
    if (!booked.ok) throw new Error(booked.error);
    f.startCode.mockResolvedValue({ data: null, error: apiError('RATE_LIMITED', 429) });

    expect(await resendBookingCode(deps(f.client), booked.booking.id)).toEqual({
      ok: false,
      error: 'We texted this number a code less than a minute ago. Wait a minute, then try again.',
    });
    expect((await store.get(booked.booking.id))?.verificationId).toBe('ver_1');
  });
});

describe('cancelAppointment', () => {
  async function booked() {
    const b = await store.create({ formToken: TOKEN, name: 'Ada', phone: '+16135550123', startsAt: STARTS.toISOString(), smsOptIn: true });
    return store.update(b.id, { reminderMessageId: 'msg_remind', reminderAt: '2026-11-19T19:00:00.000Z' });
  }

  it('cancels the scheduled reminder, then the booking', async () => {
    const { client, cancel } = fakeClient();
    cancel.mockResolvedValue({ data: null, error: null });
    const b = await booked();

    const result = await cancelAppointment({ client, store }, b.id);

    expect(cancel).toHaveBeenCalledWith('msg_remind');
    expect(result).toMatchObject({ ok: true, booking: { status: 'cancelled', reminderAt: null } });
  });

  it('still cancels when the reminder already went out', async () => {
    const { client, cancel } = fakeClient();
    cancel.mockResolvedValue({ data: null, error: apiError('MESSAGE_NOT_SCHEDULED', 422) });
    const b = await booked();

    expect(await cancelAppointment({ client, store }, b.id)).toMatchObject({ ok: true, booking: { status: 'cancelled' } });
  });

  it('keeps the booking when the reminder could not be cancelled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, cancel } = fakeClient();
    cancel.mockResolvedValue({ data: null, error: apiError('network_error', null) });
    const b = await booked();

    expect(await cancelAppointment({ client, store }, b.id)).toMatchObject({ ok: false });
    expect((await store.get(b.id))?.status).toBe('booked');
  });

  it('does not find a booking that does not exist', async () => {
    const { client } = fakeClient();
    expect(await cancelAppointment({ client, store }, '__proto__')).toMatchObject({ ok: false });
  });
});
