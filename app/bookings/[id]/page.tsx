import Link from 'next/link';
import { notFound } from 'next/navigation';
import { business } from '../../../lib/config';
import { bookingStore } from '../../../lib/deps';
import { formatPhone } from '../../../lib/phone';
import { formatAppointment } from '../../../lib/time';
import { CancelButton } from './cancel-button';
import { ConfirmPhoneForm } from './confirm-phone-form';

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const booking = await bookingStore().get(id);
  if (!booking) notFound();

  const b = business();
  const when = formatAppointment(new Date(booking.startsAt), b.timeZone);
  const cancelled = booking.status === 'cancelled';
  // CONFIRM_PHONE=true: the texts wait until the customer enters the code sent to the number.
  const awaitingCode = !cancelled && Boolean(booking.verificationId);

  return (
    <main className="card">
      <h1>{cancelled ? 'Booking cancelled' : 'You’re booked'}</h1>
      <p>
        {booking.name}, {when} with {b.name}.
      </p>

      {awaitingCode && <ConfirmPhoneForm id={booking.id} phone={formatPhone(booking.phone)} testCode={booking.testCode ?? null} />}
      {!cancelled && !awaitingCode && booking.smsOptIn && !booking.smsNote && (
        <p className="muted">
          We texted a confirmation to {formatPhone(booking.phone)}
          {booking.reminderAt
            ? ` and will text a reminder on ${formatAppointment(new Date(booking.reminderAt), b.timeZone)}.`
            : '.'}
        </p>
      )}
      {!cancelled && !awaitingCode && booking.smsNote && <p className="notice">{booking.smsNote}</p>}
      {cancelled && booking.reminderMessageId && <p className="muted">The reminder text is cancelled too.</p>}

      {!cancelled && <CancelButton id={booking.id} />}
      <p className="muted">
        {!cancelled && 'Keep this page’s link to cancel later. '}
        <Link href="/">Book another</Link>
      </p>
    </main>
  );
}
