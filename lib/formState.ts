export type FormState = {
  error?: string;
  /** What was typed, so the form keeps it after an error. */
  values?: { name: string; phone: string; startsAt: string; smsOptIn: boolean };
};
