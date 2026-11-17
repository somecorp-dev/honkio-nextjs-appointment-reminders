import { verifyWebhook, type WebhookHeaders } from '@honkio/node';

type Log = (line: string) => void;

/**
 * Checks a HonkIO webhook delivery's signature and logs the events this app
 * cares about. Returns the HTTP status to answer with.
 *
 * You don't need this to honour opt-outs: HonkIO records a STOP itself and
 * refuses every later text to that number, scheduled reminders included,
 * until the person texts START. This is where you would mirror that in your
 * own records, or show it to staff.
 *
 * HonkIO may deliver an event more than once (it retries until you answer
 * 2xx), so deduplicate on event.id before acting on one.
 */
export function handleHonkioWebhook(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  log: Log = (line) => console.log(line),
): number {
  if (!secret) return 404; // No webhook set up for this app.

  const { data: event, error } = verifyWebhook(rawBody, headers, secret);
  if (error) {
    log(`[honkio webhook] refused: ${error.message}`);
    return 400;
  }

  const d = event.data as Record<string, unknown>;
  const mode = event.livemode ? 'live' : 'test';
  switch (event.type) {
    case 'opt_out.recorded':
      log(`[honkio webhook] ${d.phone_number} texted ${d.keyword} to ${d.from_number}: opted out (${mode}). HonkIO now blocks texts to them until they text START.`);
      break;
    case 'opt_out.reinstated':
      log(`[honkio webhook] ${d.phone_number} texted ${d.keyword} to ${d.from_number}: opted back in (${mode}).`);
      break;
    case 'message.received':
      log(`[honkio webhook] text from ${d.from}: ${JSON.stringify(d.body)} (${mode})`);
      break;
    case 'message.failed':
      // A scheduled reminder that could not go out (the person opted out
      // since, or it passed its expires_at) fails here. It was refunded.
      log(`[honkio webhook] message ${d.message_id} to ${d.to} failed: ${d.error_code} (${mode})`);
      break;
    default:
      log(`[honkio webhook] ${event.type} (${mode})`);
  }
  return 200;
}

/**
 * A HonkIO event is a few kilobytes. Anyone can POST to the route, and the
 * signature can only be checked once the body is read, so a larger body is
 * refused before it fills the server's memory.
 */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

/**
 * The route's work: refuse a body over MAX_WEBHOOK_BYTES (by its
 * Content-Length, then while reading, since that header can be missing or
 * wrong), then check and log the delivery. Returns the HTTP status.
 */
export async function receiveHonkioWebhook(request: Request, secret: string, log?: Log): Promise<number> {
  if (!secret) return 404; // No webhook set up for this app.
  if (Number(request.headers.get('content-length')) > MAX_WEBHOOK_BYTES) return 413;
  const rawBody = await readAtMost(request, MAX_WEBHOOK_BYTES);
  if (!rawBody) return 413;
  return handleHonkioWebhook(rawBody, request.headers, secret, log);
}

/** The body's exact bytes, or null once it passes maxBytes (the rest is never read). */
async function readAtMost(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}
