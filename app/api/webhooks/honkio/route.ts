import { webhookSecret } from '../../../../lib/config';
import { receiveHonkioWebhook } from '../../../../lib/webhooks';

// Point a HonkIO webhook at https://<your site>/api/webhooks/honkio and put
// its signing secret in HONKIO_WEBHOOK_SECRET. See lib/webhooks.ts.
export async function POST(request: Request): Promise<Response> {
  // The signature covers the exact bytes sent, so the raw body is checked, not
  // parsed JSON. Bodies over 1 MB are refused unread.
  const status = await receiveHonkioWebhook(request, webhookSecret());
  return new Response(null, { status });
}
