'use client';

import { useActionState } from 'react';
import type { FormState } from '../../../lib/formState';
import { cancel } from '../../actions';

export function CancelButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<FormState>(cancel.bind(null, id), {});
  return (
    <form action={action} className="stack">
      {state.error && <p className="error" role="alert">{state.error}</p>}
      <button type="submit" className="secondary" disabled={pending}>
        {pending ? 'Cancelling…' : 'Cancel appointment'}
      </button>
    </form>
  );
}
