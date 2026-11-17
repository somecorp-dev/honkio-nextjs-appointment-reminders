import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Booking {
  /** Random and unguessable: the booking page's URL is the only key to it. */
  id: string;
  /** The hidden token of the form that made it, so a second submit of that form finds this booking. */
  formToken: string;
  name: string;
  phone: string;
  /** ISO 8601, UTC. */
  startsAt: string;
  createdAt: string;
  status: 'booked' | 'cancelled';
  smsOptIn: boolean;
  confirmationMessageId: string | null;
  reminderMessageId: string | null;
  /** ISO 8601: when the reminder is due to go out. */
  reminderAt: string | null;
  /** Why texts were not sent, in words the customer can read. */
  smsNote: string | null;
  /** CONFIRM_PHONE=true: the HonkIO verification whose code the customer has yet to enter. Texts wait for it. */
  verificationId?: string | null;
  /** That verification's code in test mode (always zeros), to show on the page; null when live. */
  testCode?: string | null;
}

export type NewBooking = Pick<Booking, 'formToken' | 'name' | 'phone' | 'startsAt' | 'smsOptIn'>;

export interface BookingStore {
  /** Saves a booking, or returns the one already saved with the same formToken. */
  create(input: NewBooking): Promise<Booking>;
  get(id: string): Promise<Booking | null>;
  findByFormToken(formToken: string): Promise<Booking | null>;
  update(id: string, patch: Partial<Omit<Booking, 'id'>>): Promise<Booking>;
}

/**
 * Bookings in one JSON file, written whole on every change. Fine for a demo
 * and a single server. On serverless hosting the filesystem does not last
 * between requests: swap this for your database (the BookingStore interface
 * is all the rest of the app uses).
 */
export class JsonFileStore implements BookingStore {
  // Writes run one after another so two bookings at once don't overwrite each other.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async readAll(): Promise<Record<string, Booking>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, Booking>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async writeAll(all: Record<string, Booking>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2));
    await rename(tmp, this.path);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  create(input: NewBooking): Promise<Booking> {
    return this.serial(async () => {
      const all = await this.readAll();
      // Checked inside the write queue, so two submits of one form at once still make one booking.
      const existing = Object.values(all).find((b) => b.formToken === input.formToken);
      if (existing) return existing;
      const booking: Booking = {
        id: randomUUID(),
        ...input,
        createdAt: new Date().toISOString(),
        status: 'booked',
        confirmationMessageId: null,
        reminderMessageId: null,
        reminderAt: null,
        smsNote: null,
        verificationId: null,
        testCode: null,
      };
      all[booking.id] = booking;
      await this.writeAll(all);
      return booking;
    });
  }

  async get(id: string): Promise<Booking | null> {
    await this.queue;
    const all = await this.readAll();
    return Object.hasOwn(all, id) ? all[id]! : null;
  }

  async findByFormToken(formToken: string): Promise<Booking | null> {
    await this.queue;
    const all = await this.readAll();
    return Object.values(all).find((b) => b.formToken === formToken) ?? null;
  }

  update(id: string, patch: Partial<Omit<Booking, 'id'>>): Promise<Booking> {
    return this.serial(async () => {
      const all = await this.readAll();
      if (!Object.hasOwn(all, id)) throw new Error(`No booking ${id}`);
      const current = all[id]!;
      const updated = { ...current, ...patch, id };
      all[id] = updated;
      await this.writeAll(all);
      return updated;
    });
  }
}
