'use client';

import { useActionState } from 'react';
import type { FormState } from '../../../lib/formState';
import { confirmPhone } from '../../actions';

/** CONFIRM_PHONE=true: the code texted to the number. The booking texts go out once it checks out. */
export function ConfirmPhoneForm({ id, phone, testCode }: { id: string; phone: string; testCode: string | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(confirmPhone.bind(null, id), {});
  return (
    <form action={action} className="stack">
      <p>
        To get texts about this booking, enter the code we texted to <strong>{phone}</strong>.
      </p>
      {testCode !== null && (
        <p className="notice">
          Test mode: no text was sent. The code is <code>{testCode}</code>.
        </p>
      )}
      <label htmlFor="code">Code</label>
      <input
        id="code"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={8}
        required
      />
      {state.error && <p className="error" role="alert">{state.error}</p>}
      <button type="submit" name="intent" value="check" disabled={pending}>
        {pending ? 'Checking…' : 'Confirm number'}
      </button>
      <button type="submit" name="intent" value="resend" className="link" formNoValidate disabled={pending}>
        Text me a new code
      </button>
    </form>
  );
}
