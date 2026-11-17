import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MAX_WEBHOOK_BYTES, handleHonkioWebhook, receiveHonkioWebhook } from '../lib/webhooks';

const SECRET = 'whsec_test_secret';

// Signs a body the way HonkIO does: HMAC-SHA256, hex, over `${timestamp}.${body}`,
// keyed with the secret's UTF-8 bytes.
function signed(event: object, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const headers = new Headers({
    'X-HonkIO-Signature': signature,
    'X-HonkIO-Timestamp': String(timestamp),
    'X-HonkIO-Event': (event as { type: string }).type,
  });
  return { body, headers };
}

const optOut = {
  id: 'evt_1',
  type: 'opt_out.recorded',
  created: '2026-11-17T15:00:00.000Z',
  account_id: 'acc_1',
  livemode: false,
  data: { phone_number: '+16135550123', from_number: '+16135550100', keyword: 'STOP' },
};

describe('handleHonkioWebhook', () => {
  it('accepts a correctly signed opt-out and logs it', () => {
    const log = vi.fn();
    const { body, headers } = signed(optOut);
    expect(handleHonkioWebhook(body, headers, SECRET, log)).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('+16135550123 texted STOP'));
  });

  it('logs an inbound text', () => {
    const log = vi.fn();
    const { body, headers } = signed({
      ...optOut,
      type: 'message.received',
      data: { message_id: 'msg_1', from: '+16135550123', to: '+16135550100', body: 'Running 5 min late' },
    });
    expect(handleHonkioWebhook(body, headers, SECRET, log)).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Running 5 min late'));
  });

  it('refuses a body signed with another secret', () => {
    const log = vi.fn();
    const { body, headers } = signed(optOut, 'someone-else');
    expect(handleHonkioWebhook(body, headers, SECRET, log)).toBe(400);
  });

  it('refuses a body changed after signing', () => {
    const { body, headers } = signed(optOut);
    expect(handleHonkioWebhook(body.replace('STOP', 'START'), headers, SECRET, vi.fn())).toBe(400);
  });

  it('refuses an old delivery as a possible replay', () => {
    const { body, headers } = signed(optOut, SECRET, Math.floor(Date.now() / 1000) - 3600);
    expect(handleHonkioWebhook(body, headers, SECRET, vi.fn())).toBe(400);
  });

  it('answers 404 when no webhook secret is set', () => {
    const { body, headers } = signed(optOut);
    expect(handleHonkioWebhook(body, headers, '', vi.fn())).toBe(404);
  });
});

describe('receiveHonkioWebhook', () => {
  const URL = 'https://book.example.com/api/webhooks/honkio';
  const post = (body: BodyInit, headers: Headers) => new Request(URL, { method: 'POST', body, headers });

  it('checks and logs a signed delivery', async () => {
    const log = vi.fn();
    const { body, headers } = signed(optOut);
    expect(await receiveHonkioWebhook(post(body, headers), SECRET, log)).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('+16135550123 texted STOP'));
  });

  it('answers 404 without reading the body when no webhook secret is set', async () => {
    const { body, headers } = signed(optOut);
    const request = post(body, headers);
    expect(await receiveHonkioWebhook(request, '')).toBe(404);
    expect(request.bodyUsed).toBe(false);
  });

  it('refuses a body whose Content-Length is over 1 MB, unread', async () => {
    const { body, headers } = signed(optOut);
    headers.set('content-length', String(MAX_WEBHOOK_BYTES + 1));
    const request = post(body, headers);
    expect(await receiveHonkioWebhook(request, SECRET)).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  it('stops reading a body that passes 1 MB without saying so in Content-Length', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024);
    // An endless stream: the route must give up, not read it all.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const { headers } = signed(optOut);
    const request = new Request(URL, { method: 'POST', body: endless, headers, duplex: 'half' } as RequestInit);
    expect(await receiveHonkioWebhook(request, SECRET)).toBe(413);
    expect(pulled).toBeLessThan(MAX_WEBHOOK_BYTES * 2);
  });

  it('accepts a body of exactly 1 MB as far as size goes', async () => {
    const event = { ...optOut, data: { ...optOut.data, padding: '' } };
    const size = JSON.stringify(event).length;
    event.data.padding = 'x'.repeat(MAX_WEBHOOK_BYTES - size);
    const { body, headers } = signed(event);
    expect(body.length).toBe(MAX_WEBHOOK_BYTES);
    expect(await receiveHonkioWebhook(post(body, headers), SECRET, vi.fn())).toBe(200);
  });
});
