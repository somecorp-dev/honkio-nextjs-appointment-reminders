import { resolve } from 'node:path';
import type { Deps } from './bookings';
import { bookingsFile, business, fromNumber, textPolicy } from './config';
import { honkio } from './honkio';
import { RateLimiter } from './rateLimit';
import { JsonFileStore } from './store';

// Server only: wires the real SDK client and the JSON file store together.

let store: JsonFileStore | undefined;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The limits, kept in this process's memory: see lib/rateLimit.ts.
//   5 bookings per visitor IP an hour, texts or not. New codes count here too.
//   Bookings that text the number (with CONFIRM_PHONE, once the code checks
//   out): 3 per number from one IP a day, so a stranger booking with your
//   number uses up only their own three, and 10 per number a day from all
//   IPs, the backstop against someone rotating IPs.
//   Confirmation codes (CONFIRM_PHONE=true): 3 per number from one IP every
//   15 minutes, and 10 per number an hour from all IPs, as in the sign-in
//   starter. HonkIO also sends one code per number a minute.
const limits = {
  perIp: new RateLimiter(5, HOUR),
  texts: { perPhoneAndIp: new RateLimiter(3, DAY), perPhone: new RateLimiter(10, DAY) },
  codes: { perPhoneAndIp: new RateLimiter(3, 15 * MINUTE), perPhone: new RateLimiter(10, HOUR) },
};

export function bookingStore(): JsonFileStore {
  // The comment stops the bundler from tracing the whole project for this runtime path.
  store ??= new JsonFileStore(resolve(/*turbopackIgnore: true*/ process.cwd(), bookingsFile()));
  return store;
}

export function deps(): Deps {
  return { client: honkio(), store: bookingStore(), business: business(), from: fromNumber(), policy: textPolicy(), limits };
}
