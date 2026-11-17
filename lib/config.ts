// Settings are read when a request needs them, not at import time, so
// `next build` works without a .env file.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  return value;
}

export function honkioApiKey(): string {
  return required('HONKIO_API_KEY');
}

export function fromNumber(): string {
  return required('HONKIO_FROM_NUMBER');
}

export interface Business {
  name: string;
  contact: string;
  timeZone: string;
  reminderHoursBefore: number;
}

export function business(): Business {
  return {
    name: notExample('BUSINESS_NAME', process.env.BUSINESS_NAME?.trim() || 'Acme Clinic'),
    // CASL: a request for consent has to say how to reach you. Shown next to
    // the opt-in box and kept with each consent record, so it can't be empty.
    contact: notExample('BUSINESS_CONTACT', required('BUSINESS_CONTACT')),
    timeZone: process.env.BUSINESS_TIMEZONE?.trim() || 'America/Toronto',
    reminderHoursBefore: reminderHoursBefore(),
  };
}

/**
 * The name and contact line go into every consent record, so production
 * refuses the sample values: the default name, or an example.com address.
 */
function notExample(name: string, value: string): string {
  if (process.env.NODE_ENV === 'production' && (/example\.com/i.test(value) || value.toLowerCase() === 'acme clinic')) {
    throw new Error(`${name} is still the example value ("${value}"). Set your own business name and contact details.`);
  }
  return value;
}

function reminderHoursBefore(): number {
  const raw = process.env.REMINDER_HOURS_BEFORE?.trim();
  if (!raw) return 24;
  const hours = Number(raw);
  // Bookings are at most 30 days out, so a reminder further ahead than that would never be sent.
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    throw new Error('REMINDER_HOURS_BEFORE must be a whole number of hours from 1 to 720 (30 days).');
  }
  return hours;
}

/**
 * How the app guards texts to the number typed into the form:
 *   confirm: CONFIRM_PHONE=true. Text a HonkIO Verify code to the number and
 *            send the booking texts only once it is entered.
 *   send:    text the number as typed. Development, or production with
 *            ALLOW_UNCONFIRMED_BOOKINGS=true.
 *   refuse:  production with neither set. Bookings are saved, nothing is
 *            texted, and the server log says why.
 */
export type TextPolicy = 'confirm' | 'send' | 'refuse';

export function textPolicy(): TextPolicy {
  if (process.env.CONFIRM_PHONE?.trim() === 'true') return 'confirm';
  if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_UNCONFIRMED_BOOKINGS?.trim() === 'true') return 'send';
  return 'refuse';
}

/**
 * The booking form's address (APP_URL), kept with each consent record. Read
 * from your settings, not the request's Host header, which the visitor
 * controls. Undefined while APP_URL is not set.
 */
export function bookingFormUrl(): string | undefined {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return undefined;
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error('APP_URL must be the full address of your site, like https://book.example.com.');
  }
  // HonkIO keeps up to 2048 characters of it.
  if (url.href.length > 2048) throw new Error('APP_URL must be at most 2048 characters.');
  return url.href;
}

/**
 * How many proxies in front of the app add to X-Forwarded-For. See
 * lib/clientIp.ts, which never asks on Vercel or Fly.io.
 *
 * Required in production: a bare `next start` fills in X-Forwarded-For only
 * when the request has none, so with nothing in front of the app the visitor
 * writes the entry a default of 1 would trust. In development it defaults to 1.
 */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) {
    if (process.env.NODE_ENV !== 'production') return 1;
    throw new Error(
      'TRUSTED_PROXY_HOPS is not set. In production, set it to how many proxies in front of the app add to X-Forwarded-For: ' +
        '0 for a bare `next start` with nothing in front, 1 behind one proxy (Railway, Render, nginx).',
    );
  }
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error('TRUSTED_PROXY_HOPS must be a whole number from 0 to 10.');
  }
  return hops;
}

/** Empty when no webhook is set up. */
export function webhookSecret(): string {
  return process.env.HONKIO_WEBHOOK_SECRET?.trim() ?? '';
}

export function bookingsFile(): string {
  return process.env.BOOKINGS_FILE?.trim() || 'data/bookings.json';
}
