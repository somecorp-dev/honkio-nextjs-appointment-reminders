'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { bookAppointment, cancelAppointment, confirmBookingPhone, parseBookingForm, resendBookingCode } from '../lib/bookings';
import { clientIp } from '../lib/clientIp';
import { bookingFormUrl, business } from '../lib/config';
import { deps } from '../lib/deps';
import type { FormState } from '../lib/formState';

export async function book(_prev: FormState, form: FormData): Promise<FormState> {
  const failed = (error: string): FormState => ({
    error,
    values: {
      name: String(form.get('name') ?? ''),
      phone: String(form.get('phone') ?? ''),
      startsAt: String(form.get('startsAt') ?? ''),
      smsOptIn: form.get('smsOptIn') === 'on',
    },
  });

  // The honeypot: people never see this field, so only a bot fills it in.
  if (String(form.get('website') ?? '') !== '') return failed('We couldn’t take that booking. Please try again.');

  const parsed = parseBookingForm(
    {
      formToken: form.get('formToken'),
      name: form.get('name'),
      phone: form.get('phone'),
      startsAt: form.get('startsAt'),
      smsOptIn: form.get('smsOptIn'),
    },
    business(),
    new Date(),
  );
  if (!parsed.ok) return failed(parsed.error);

  // Kept with the consent record: the form's address and the IP the box was ticked from.
  const ip = clientIp(await headers()) ?? undefined;
  const result = await bookAppointment(deps(), parsed.input, { ip, url: bookingFormUrl() });
  if (!result.ok) return failed(result.error);
  redirect(`/bookings/${result.booking.id}`);
}

/** The booking page's code form (CONFIRM_PHONE=true): check the code, or text a new one. */
export async function confirmPhone(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const ip = clientIp(await headers()) ?? undefined;
  const result =
    form.get('intent') === 'resend'
      ? await resendBookingCode(deps(), id, { ip })
      : await confirmBookingPhone(deps(), id, String(form.get('code') ?? ''), { ip, url: bookingFormUrl() });
  if (!result.ok) return { error: result.error };
  redirect(`/bookings/${id}`);
}

export async function cancel(id: string, _prev: FormState): Promise<FormState> {
  const { client, store } = deps();
  const result = await cancelAppointment({ client, store }, id);
  if (!result.ok) return { error: result.error };
  redirect(`/bookings/${id}`);
}
