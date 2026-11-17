'use client';

import { useActionState } from 'react';
import type { FormState } from '../lib/formState';
import { book } from './actions';

interface Props {
  formToken: string;
  consentLabel: string;
  contactLine: string;
  min: string;
  max: string;
  timeZone: string;
  /** CONFIRM_PHONE=true: the number gets a code to confirm before any other text. */
  confirmPhone: boolean;
}

export function BookingForm({ formToken, consentLabel, contactLine, min, max, timeZone, confirmPhone }: Props) {
  const [state, action, pending] = useActionState<FormState, FormData>(book, {});
  const v = state.values;

  return (
    <form action={action} className="stack">
      {/* One per page load: sending this form twice finds the first booking instead of making a second. */}
      <input type="hidden" name="formToken" value={formToken} />

      {/* The honeypot: hidden from people and screen readers. A bot that fills in every field fills this too. */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="website">Leave this empty</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <label htmlFor="name">Name</label>
      <input id="name" name="name" autoComplete="name" maxLength={100} defaultValue={v?.name} required />

      <label htmlFor="phone">Mobile number</label>
      <input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel-national" defaultValue={v?.phone} required />

      <label htmlFor="startsAt">Date and time</label>
      <input id="startsAt" name="startsAt" type="datetime-local" min={min} max={max} defaultValue={v?.startsAt} required />
      <p className="muted">Times are in {timeZone.replace(/_/g, ' ')}.</p>

      {/* Unticked by default: express consent has to be the customer's own action. */}
      <label className="checkbox">
        <input type="checkbox" name="smsOptIn" defaultChecked={v?.smsOptIn ?? false} />
        <span>{consentLabel}</span>
      </label>
      <p className="muted">
        {contactLine}. Canadian mobile numbers only.{confirmPhone && ' We’ll text you a code to confirm the number first.'} Optional: you can
        book without texts.
      </p>

      {state.error && <p className="error" role="alert">{state.error}</p>}
      <button type="submit" disabled={pending}>
        {pending ? 'Booking…' : 'Book appointment'}
      </button>
    </form>
  );
}
