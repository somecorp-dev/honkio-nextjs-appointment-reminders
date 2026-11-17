import type { Honkio, HonkioError } from '@honkio/node';
import type { Business, TextPolicy } from './config';
import { formatPhone, toE164 } from './phone';
import { takePhone, type PhoneLimits, type RateLimiter } from './rateLimit';
import type { Booking, BookingStore } from './store';
import { formatAppointment, zonedToUtc } from './time';

/** The part of the SDK this file uses, so tests can pass a fake. */
export type SmsClient = {
  messages: Pick<Honkio['messages'], 'send' | 'cancel'>;
  consents: Pick<Honkio['consents'], 'create'>;
  verify: Pick<Honkio['verify'], 'start' | 'check'>;
};

export interface Deps {
  client: SmsClient;
  store: BookingStore;
  business: Business;
  /** The HonkIO number texts come from. */
  from: string;
  /** Whether the number typed in is confirmed, texted as is, or not texted. See textPolicy in lib/config.ts. */
  policy: TextPolicy;
  /** Booking and text limits. See lib/deps.ts. */
  limits?: Limits;
  now?: () => Date;
}

export interface Limits {
  /** Bookings (texts or not) and new confirmation codes, per visitor IP. */
  perIp: RateLimiter;
  /** Bookings that text the number. With CONFIRM_PHONE, counted once the code checks out. */
  texts: PhoneLimits;
  /** Confirmation codes texted to a number (CONFIRM_PHONE=true). */
  codes: PhoneLimits;
}

/** Where the booking came from, for the consent record and the limits. */
export interface Source {
  ip?: string;
  url?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** HonkIO schedules a message 1 minute to 30 days ahead. Bookings stay inside that window. */
export const MAX_DAYS_AHEAD = 30;
/** A reminder due sooner than this after booking is skipped: the confirmation covers it. */
const MIN_REMINDER_LEAD = 5 * MINUTE;

/** The opt-in box's text. It is stored word for word with the consent record. */
export function consentLabel(b: Business): string {
  return `Text me a confirmation and a reminder about this appointment from ${b.name}. I can reply STOP at any time to stop these texts.`;
}

/** Who is asking for consent and how to reach them, shown under the box (CASL). */
export function contactLine(b: Business): string {
  return `${b.name}, ${b.contact}`;
}

/**
 * How the consent was given, for HonkIO's consent record: which form, which
 * booking, the exact words agreed to and the contact details shown with them.
 * It says only what the form can show: whoever booked ticked the box for the
 * number they typed, and, with CONFIRM_PHONE, entered the code texted to it.
 */
export function consentSource(b: Business, bookingId: string, confirmed = false): string {
  const confirmation = confirmed ? ', then confirmed the number by entering a one-time code texted to it' : '';
  return (
    `The person booking ticked the unticked SMS opt-in box on the ${b.name} appointment booking form for the mobile number they entered (booking ${bookingId})${confirmation}. ` +
    `Box text: "${consentLabel(b)}" Shown with the box: "${contactLine(b)}"`
  );
}

export function confirmationText(b: Business, startsAt: Date, reminderScheduled: boolean): string {
  const when = formatAppointment(startsAt, b.timeZone);
  const reminder = reminderScheduled ? ` We'll text a reminder ${hoursText(b.reminderHoursBefore)} before.` : '';
  return `${b.name}: your appointment is booked for ${when}.${reminder} Reply STOP to opt out.`;
}

export function reminderText(b: Business, startsAt: Date): string {
  return `${b.name} reminder: your appointment is ${formatAppointment(startsAt, b.timeZone)}. Reply STOP to opt out.`;
}

function hoursText(h: number): string {
  if (h % 24 === 0) return h === 24 ? '1 day' : `${h / 24} days`;
  return h === 1 ? '1 hour' : `${h} hours`;
}

export type ReminderPlan =
  | { kind: 'scheduled'; scheduledAt: Date; expiresAt: Date }
  | { kind: 'too_soon' };

/**
 * When the reminder goes out, and the latest it may still go out. HonkIO
 * holds a scheduled text through a pause or a sending limit until its
 * expires_at (at most 24 hours after scheduled_at), then fails and refunds
 * it. A reminder after the appointment is useless, so expires_at is the
 * appointment itself, or 24 hours after scheduled_at if that comes first.
 */
export function planReminder(startsAt: Date, now: Date, hoursBefore: number): ReminderPlan {
  const scheduledAt = new Date(startsAt.getTime() - hoursBefore * HOUR);
  if (scheduledAt.getTime() < now.getTime() + MIN_REMINDER_LEAD) return { kind: 'too_soon' };
  const latest = Math.min(scheduledAt.getTime() + DAY, startsAt.getTime());
  const expiresAt = new Date(Math.max(latest, scheduledAt.getTime() + MINUTE));
  return { kind: 'scheduled', scheduledAt, expiresAt };
}

export interface BookingInput {
  /** The hidden form token: one per page load, so a second submit of the same form is spotted. */
  formToken: string;
  name: string;
  phone: string;
  startsAt: Date;
  smsOptIn: boolean;
}

/** Checks the form. Returns the cleaned input, or what to fix. */
export function parseBookingForm(
  form: { formToken?: unknown; name?: unknown; phone?: unknown; startsAt?: unknown; smsOptIn?: unknown },
  b: Business,
  now: Date,
): { ok: true; input: BookingInput } | { ok: false; error: string } {
  const formToken = String(form.formToken ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(formToken)) {
    return { ok: false, error: 'This form is out of date. Reload the page and try again.' };
  }
  const name = String(form.name ?? '').trim();
  if (!name || name.length > 100) return { ok: false, error: 'Enter your name.' };
  const phone = toE164(String(form.phone ?? ''));
  if (!phone) return { ok: false, error: 'Enter a 10-digit phone number.' };
  const time = zonedToUtc(String(form.startsAt ?? ''), b.timeZone);
  if (!time.ok && time.reason === 'skipped') {
    return { ok: false, error: 'That time doesn’t exist: the clocks go forward an hour that night. Pick another time.' };
  }
  if (!time.ok) return { ok: false, error: 'Pick a date and time.' };
  const startsAt = time.date;
  if (startsAt.getTime() < now.getTime() + 15 * MINUTE) return { ok: false, error: 'Pick a time at least 15 minutes from now.' };
  if (startsAt.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY) {
    return { ok: false, error: `Appointments can be booked up to ${MAX_DAYS_AHEAD} days ahead.` };
  }
  return { ok: true, input: { formToken, name, phone, startsAt, smsOptIn: form.smsOptIn === 'on' || form.smsOptIn === true } };
}

function logForOwner(where: string, error: HonkioError): void {
  console.error(`[honkio] ${where} failed: ${error.name} (${error.statusCode ?? 'no response'}): ${error.message}`);
}

/**
 * Anyone can type any number into the form, so production texts only a number
 * that was confirmed with a code, unless ALLOW_UNCONFIRMED_BOOKINGS=true (see
 * textPolicy in lib/config.ts). This tells the owner why nothing was sent.
 */
function logTextsRefused(): void {
  console.error(
    '[honkio] Booking texts not sent: anyone can type any number into the form, so in production this app texts a number only once it is confirmed. ' +
      'Set CONFIRM_PHONE=true to confirm each number with a HonkIO Verify code first, or ALLOW_UNCONFIRMED_BOOKINGS=true to text numbers as typed (add a CAPTCHA).',
  );
}

const NOT_SENT = 'Your booking is saved, but we couldn’t send texts about it right now.';
const TOO_MANY_FROM_IP = 'Too many bookings from your connection. Please try again later.';
const TOO_MANY_CODES = 'Too many codes sent to this number. Please try again later, or book without texts.';
const DIGITS_ONLY = 'Enter the code from the text, digits only.';
const NO_CODE = 'There’s no code to enter for this booking.';

/** What to tell the customer when a text was refused. The booking itself always stands. */
export function smsErrorMessage(error: HonkioError, from: string, where: string): string {
  switch (error.name) {
    case 'OPT_OUT_BLOCKED':
      // The number texted STOP to us before. Only the customer can undo that.
      return `This number opted out of our texts, so we won’t text you about this booking. Text START to ${formatPhone(from)} to get our texts again.`;
    case 'NOT_A_MOBILE_NUMBER':
      return 'That number can’t receive texts, so we won’t text you about this booking.';
    case 'NON_CANADIAN_NUMBER':
      return 'We can only text Canadian mobile numbers, so we won’t text you about this booking.';
    case 'INVALID_PHONE_NUMBER':
    case 'RESERVED_DESTINATION':
    case 'UNDELIVERABLE_NUMBER':
      return 'We can’t text that number, so we won’t text you about this booking.';
    case 'RATE_LIMITED':
      // verify.start: HonkIO sends one code per number a minute.
      return 'We texted this number a code less than a minute ago. Wait a minute, then try again.';
    default:
      // A balance, key, consent or sending-limit problem, or a VALIDATION_ERROR
      // (a field this app sent was refused): yours to fix, not the customer's.
      logForOwner(where, error);
      return NOT_SENT;
  }
}

/** What to tell the customer when HonkIO refused the confirmation code they typed. */
export function codeErrorMessage(error: HonkioError): string {
  switch (error.name) {
    case 'VERIFICATION_INVALID_CODE': {
      const left = (error.details as { attempts_remaining?: unknown } | undefined)?.attempts_remaining;
      if (typeof left === 'number') return `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
      return 'That code isn’t right. Check the text and try again.';
    }
    case 'VALIDATION_ERROR':
      return DIGITS_ONLY;
    case 'VERIFICATION_EXPIRED':
      return 'That code has expired. Ask for a new one.';
    case 'VERIFICATION_MAX_ATTEMPTS':
      return 'Too many wrong codes. Ask for a new one.';
    case 'VERIFICATION_ALREADY_VERIFIED':
      return 'That code was already used. Reload the page, or ask for a new code.';
    default:
      logForOwner('verify.check', error);
      return 'We couldn’t check that code just now. Please try again.';
  }
}

export type BookResult = { ok: true; booking: Booking } | { ok: false; error: string };

/**
 * Saves the booking. If the customer ticked the box, then, by policy:
 *   confirm: texts a HonkIO Verify code to the number. The texts wait for
 *            confirmBookingPhone.
 *   send:    records their consent, schedules the reminder and texts a
 *            confirmation now.
 *   refuse:  sends nothing and logs why.
 * A text that fails never undoes the booking; it leaves a note on it.
 */
export async function bookAppointment(deps: Deps, input: BookingInput, source: Source = {}): Promise<BookResult> {
  const { store, limits, policy } = deps;

  // The same form sent twice (a double click, a retry after a timeout) gets
  // the first booking back, and nothing is sent again.
  const existing = await store.findByFormToken(input.formToken);
  if (existing) return { ok: true, booking: existing };

  // With no trustworthy IP (see lib/clientIp.ts) only the per-number limits apply.
  if (limits && source.ip && !limits.perIp.take(source.ip)) return { ok: false, error: TOO_MANY_FROM_IP };
  // Only a booking that texts the number counts against it. With CONFIRM_PHONE
  // the text sent now is the code; the booking counts once the code checks out.
  if (limits && input.smsOptIn && policy === 'confirm' && !takePhone(limits.codes, input.phone, source.ip)) {
    return { ok: false, error: TOO_MANY_CODES };
  }
  if (limits && input.smsOptIn && policy === 'send' && !takePhone(limits.texts, input.phone, source.ip)) {
    return { ok: false, error: 'Too many bookings for this number today. Please try again tomorrow.' };
  }

  const booking = await store.create({
    formToken: input.formToken,
    name: input.name,
    phone: input.phone,
    startsAt: input.startsAt.toISOString(),
    smsOptIn: input.smsOptIn,
  });
  if (!input.smsOptIn) return { ok: true, booking };

  if (policy === 'refuse') {
    logTextsRefused();
    return { ok: true, booking: await store.update(booking.id, { smsNote: NOT_SENT }) };
  }
  if (policy === 'confirm') {
    const code = await startCode(deps, booking.phone);
    return { ok: true, booking: await store.update(booking.id, code.ok ? code.patch : { smsNote: code.message }) };
  }
  return { ok: true, booking: await sendBookingTexts(deps, booking, source, false) };
}

/**
 * Checks the code the customer typed on the booking page (CONFIRM_PHONE=true).
 * Once it checks out, the booking counts against the number's limits, and the
 * consent and texts go out as bookAppointment sends them without CONFIRM_PHONE.
 */
export async function confirmBookingPhone(deps: Deps, id: string, code: string, source: Source = {}): Promise<BookResult> {
  const booking = await deps.store.get(id);
  if (!booking?.verificationId || booking.status === 'cancelled') return { ok: false, error: NO_CODE };
  const typed = code.replace(/\s/g, '');
  if (!/^\d{4,8}$/.test(typed)) return { ok: false, error: DIGITS_ONLY };

  const { error } = await deps.client.verify.check(booking.verificationId, { code: typed });
  if (error) return { ok: false, error: codeErrorMessage(error) };

  const confirmed = await deps.store.update(id, { verificationId: null, testCode: null });
  if (deps.limits && !takePhone(deps.limits.texts, booking.phone, source.ip)) {
    const smsNote = 'This number has had too many bookings today, so we won’t text you about this one.';
    return { ok: true, booking: await deps.store.update(id, { smsNote }) };
  }
  return { ok: true, booking: await sendBookingTexts(deps, confirmed, source, true) };
}

/** Texts a new confirmation code for a booking that is waiting for one. */
export async function resendBookingCode(deps: Deps, id: string, source: Source = {}): Promise<BookResult> {
  const booking = await deps.store.get(id);
  if (!booking?.verificationId || booking.status === 'cancelled') return { ok: false, error: NO_CODE };
  const { limits } = deps;
  if (limits && source.ip && !limits.perIp.take(source.ip)) return { ok: false, error: TOO_MANY_FROM_IP };
  if (limits && !takePhone(limits.codes, booking.phone, source.ip)) return { ok: false, error: TOO_MANY_CODES };

  const code = await startCode(deps, booking.phone);
  if (!code.ok) return { ok: false, error: code.message };
  return { ok: true, booking: await deps.store.update(id, code.patch) };
}

/**
 * Texts a HonkIO Verify code to the number. A code needs no consent. It is
 * charged like a sign-in code; see "What it costs" in the README.
 */
async function startCode(deps: Deps, phone: string) {
  const { data, error } = await deps.client.verify.start({ to: phone, from: deps.from, appName: deps.business.name });
  if (error) return { ok: false as const, message: smsErrorMessage(error, deps.from, 'verify.start') };
  // test_code: the code that completes a test-mode verification (always zeros), shown on the page; null when live.
  return { ok: true as const, patch: { verificationId: data.id, testCode: data.test_code ?? null } };
}

/** Records consent, schedules the reminder and texts a confirmation now. */
async function sendBookingTexts(deps: Deps, booking: Booking, source: Source, confirmed: boolean): Promise<Booking> {
  const { client, business: b, from } = deps;
  const now = deps.now?.() ?? new Date();
  const startsAt = new Date(booking.startsAt);

  // 1. Consent first: HonkIO refuses an SMS to a number with no consent on file.
  const consent = await client.consents.create({
    phoneNumber: booking.phone,
    consentType: 'express',
    sourceDescription: consentSource(b, booking.id, confirmed),
    ...(source.ip && { sourceIp: source.ip }),
    ...(source.url && { sourceUrl: source.url }),
  });
  if (consent.error) return deps.store.update(booking.id, { smsNote: smsErrorMessage(consent.error, from, 'consents.create') });

  // Every send's idempotency key comes from the booking id, so a retry, or two
  // submits racing to the same booking, returns the first send instead of
  // texting twice.
  const patch: Partial<Booking> = {};

  // 2. The reminder, scheduled before the confirmation goes out, so the
  //    confirmation only promises a reminder HonkIO has accepted. HonkIO holds
  //    it and sends it at scheduledAt; an opt-out in the meantime stops it
  //    (and refunds it).
  const plan = planReminder(startsAt, now, b.reminderHoursBefore);
  if (plan.kind === 'scheduled') {
    const reminder = await client.messages.send(
      { from, to: booking.phone, body: reminderText(b, startsAt), scheduledAt: plan.scheduledAt, expiresAt: plan.expiresAt },
      { idempotencyKey: `booking-${booking.id}-reminder` },
    );
    if (reminder.error) {
      // The confirmation below still goes out, without the reminder line.
      logForOwner('messages.send (reminder)', reminder.error);
    } else {
      patch.reminderMessageId = reminder.data.id;
      patch.reminderAt = reminder.data.scheduled_at ?? plan.scheduledAt.toISOString();
    }
  }

  // 3. The confirmation, now.
  const confirmation = await client.messages.send(
    { from, to: booking.phone, body: confirmationText(b, startsAt, patch.reminderMessageId != null) },
    { idempotencyKey: `booking-${booking.id}-confirmation` },
  );
  if (confirmation.error) {
    patch.smsNote = smsErrorMessage(confirmation.error, from, 'messages.send (confirmation)');
  } else {
    patch.confirmationMessageId = confirmation.data.id;
  }
  return deps.store.update(booking.id, patch);
}

export type CancelResult = { ok: true; booking: Booking } | { ok: false; error: string };

/** Cancels the booking and its scheduled reminder (HonkIO refunds a cancelled scheduled text). */
export async function cancelAppointment(deps: Pick<Deps, 'client' | 'store'>, id: string): Promise<CancelResult> {
  const booking = await deps.store.get(id);
  if (!booking) return { ok: false, error: 'We couldn’t find that booking.' };
  if (booking.status === 'cancelled') return { ok: true, booking };

  if (booking.reminderMessageId) {
    const { error } = await deps.client.messages.cancel(booking.reminderMessageId);
    // MESSAGE_NOT_SCHEDULED: it already went out or failed; NOT_FOUND: it is gone. Nothing left to stop.
    if (error && error.name !== 'MESSAGE_NOT_SCHEDULED' && error.name !== 'NOT_FOUND') {
      logForOwner('messages.cancel', error);
      return { ok: false, error: 'We couldn’t cancel the reminder text just now, so the booking is still on. Please try again.' };
    }
  }

  return { ok: true, booking: await deps.store.update(id, { status: 'cancelled', reminderAt: null }) };
}
