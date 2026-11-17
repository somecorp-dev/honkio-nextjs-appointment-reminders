import { randomUUID } from 'node:crypto';
import { MAX_DAYS_AHEAD, consentLabel, contactLine } from '../lib/bookings';
import { business, textPolicy } from '../lib/config';
import { toLocalInput } from '../lib/time';
import { BookingForm } from './booking-form';

// Rendered per request: the earliest and latest bookable times move with the
// clock, and each page load gets its own form token.
export const dynamic = 'force-dynamic';

export default function Home() {
  const b = business();
  const now = Date.now();
  return (
    <main className="card">
      <h1>Book an appointment</h1>
      <p className="muted">with {b.name}</p>
      <BookingForm
        formToken={randomUUID()}
        consentLabel={consentLabel(b)}
        contactLine={contactLine(b)}
        min={toLocalInput(new Date(now + 15 * 60_000), b.timeZone)}
        max={toLocalInput(new Date(now + MAX_DAYS_AHEAD * 86_400_000), b.timeZone)}
        timeZone={b.timeZone}
        confirmPhone={textPolicy() === 'confirm'}
      />
    </main>
  );
}
