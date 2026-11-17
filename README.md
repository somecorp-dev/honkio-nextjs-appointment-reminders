# Appointment reminders for Next.js with HonkIO

A Next.js (App Router) starter for a booking form that texts a confirmation right away and a reminder before the appointment. Texts are sent with [HonkIO](https://honkio.ca), a Canadian SMS API with CASL consent built in and data stored in Canada.

- A booking form with an **unticked** opt-in box. Ticking it records express consent with HonkIO for the number entered, naming the form, the exact words agreed to and the contact details shown with them.
- The reminder is scheduled with HonkIO (`scheduledAt`), so there is no cron job or queue to run, and a confirmation text goes out at once.
- Optional number confirmation (`CONFIRM_PHONE=true`): a [HonkIO Verify](https://honkio.ca/docs/sms/verify) code goes to the number first, and nothing else is texted until it is entered.
- Per-IP and per-number limits, a honeypot field, and a form token so a double submit never books or texts twice.
- Cancelling the booking cancels the scheduled reminder, and HonkIO refunds it.
- STOP is handled for you: HonkIO records the opt-out and refuses later texts to that number, scheduled ones included.
- An optional webhook route checks HonkIO's signature and logs opt-outs, replies and failed texts.
- Bookings are kept in a JSON file, so there is nothing else to install. Works in test mode out of the box.

## Setup

1. Create a HonkIO account at [honkio.ca](https://honkio.ca) and make a **test** API key under [API keys](https://honkio.ca/dashboard/keys). It starts with `mk_test_`.
2. Clone this folder and install:
   ```sh
   npm install
   ```
3. Copy the example settings and fill them in:
   ```sh
   cp .env.example .env.local
   ```
   Set `HONKIO_API_KEY` to your test key and `HONKIO_FROM_NUMBER` to a Canadian number in E.164 (`+1` and ten digits). Set `BUSINESS_NAME`, `BUSINESS_CONTACT` (required, and empty until you fill it in) and `BUSINESS_TIMEZONE` to yours. See [Settings](#settings) for the rest.
4. Start it:
   ```sh
   npm run dev
   ```
5. Open http://localhost:3000, book a time with your mobile number, and tick the box. The booking page shows the confirmation and when the reminder is due; the texts appear under Messages in the HonkIO dashboard.

`npm test` runs the unit tests (the SDK is replaced by a fake, so they need no key and no network).

## Test keys and live keys

With a test key (`mk_test_...`):

- No text is sent and nothing is charged. HonkIO still runs every check a live send gets (consent, opt-outs, Canadian number, scheduling window), so the errors you see are the real ones.
- Consent recorded with a test key covers test sends only. It never carries over to live.
- `HONKIO_FROM_NUMBER` can be any valid Canadian number, so you can build the whole flow before you buy one.
- With `CONFIRM_PHONE=true`, the confirmation code is always `000000`, and the booking page shows it.

With a live key (`mk_live_...`):

- Texts are real and charged to your prepaid balance. A scheduled text is charged when it is scheduled and refunded if it is cancelled or can't go out.
- `HONKIO_FROM_NUMBER` must be one of your HonkIO numbers. Buy one in the dashboard under Phone numbers.
- Your account needs its owner phone verified once before it can send live.

## How it works

| File | What it does |
|---|---|
| `lib/bookings.ts` | Booking, consent, the two texts, and cancelling. All the HonkIO calls are here. |
| `app/actions.ts` | The server actions behind the form and the cancel button. |
| `lib/webhooks.ts`, `app/api/webhooks/honkio/route.ts` | The optional webhook receiver. |
| `lib/store.ts` | The JSON file store. Swap it for your database. |
| `lib/time.ts` | Reads the form's date and time in the business's time zone, including the nights the clocks change. |
| `lib/rateLimit.ts`, `lib/deps.ts` | The limits on bookings, texts and codes, per visitor IP and per phone number. |
| `lib/clientIp.ts` | Works out the visitor's IP from the headers your host sets. |
| `app/bookings/[id]/confirm-phone-form.tsx` | With `CONFIRM_PHONE=true`, the booking page's form for the code texted to the number. |
| `next.config.ts` | Security headers: no page may be framed, and booking pages send no referrer and ask not to be indexed. |

When a customer books with the box ticked:

1. **Consent:** `consents.create({ phoneNumber, consentType: 'express', sourceDescription, sourceIp, sourceUrl })`. The source description says the person booking ticked the box for the number they entered, names the form and the booking, and quotes the box's text and the contact line shown with it. `sourceIp` is sent only when the visitor's IP is known, and `sourceUrl` comes from `APP_URL`, never from the request. HonkIO refuses any text to a number without consent on file, so this comes first.
2. **Reminder:** `messages.send({ from, to, body, scheduledAt, expiresAt })`. `scheduledAt` is `REMINDER_HOURS_BEFORE` before the appointment. `expiresAt` is the appointment itself, so a reminder held up by a sending limit is dropped (and refunded) rather than sent after the appointment.
3. **Confirmation:** `messages.send({ from, to, body })`, sent at once. It says a reminder is coming only if step 2 succeeded.

The form carries a hidden token, a random UUID made each time the page loads. Sending the same form twice (a double click, a retry after a timeout) finds the first booking and sends nothing new. Each send also carries an idempotency key made from the booking id (`booking-<id>-reminder`, `booking-<id>-confirmation`), so even two submits racing each other text the customer once.

Without the box ticked, the booking is saved and nothing is sent.

With `CONFIRM_PHONE=true`, ticking the box first texts a code to the number with `verify.start({ to, from, appName })`. A code needs no consent, and nothing else is sent yet. The booking page asks for the code and checks it with `verify.check(id, { code })`; only then do steps 1 to 3 run, and the consent record adds that the number was confirmed with a code texted to it. The page can text a new code if the first one expires.

In production (`NODE_ENV=production`) without `CONFIRM_PHONE=true` or `ALLOW_UNCONFIRMED_BOOKINGS=true`, a booking with the box ticked is saved but nothing is sent and no consent is recorded. The booking page says texts couldn't be sent, and your server log says why.

## Consent and STOP

The opt-in box starts unticked and is optional: booking works without it. Express consent under CASL has to be the customer's own action, and the request has to say who is asking and how to reach them, which is why `BUSINESS_NAME` and `BUSINESS_CONTACT` are shown next to the box. The texts end with "Reply STOP to opt out." This is a starting point, not legal advice; see [honkio.ca/docs/sms/consent](https://honkio.ca/docs/sms/consent).

You don't write any STOP handling. When someone texts STOP (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) to your number, HonkIO records the opt-out, and every later text to them is refused with `OPT_OUT_BLOCKED` until they text START. A reminder already scheduled fails when it comes due and is refunded. If a customer who opted out books again, the booking page tells them how to opt back in.

## Before you go live

- **Confirm the number, or the form will text any number anyone types.** Without confirmation, a bot (rotating IPs to get past the limits) can fill the form with numbers it doesn't own: each booking records express consent and texts that number, at your cost and in your name. Set `CONFIRM_PHONE=true` so each number gets a [HonkIO Verify](https://honkio.ca/docs/sms/verify) code first, and the consent record and the texts wait until the code is entered. Each code is charged like any verification: the SMS rate plus a verification upcharge (`pricing.get()` returns it as `verification_cost_cents`; see [What it costs](#what-it-costs)). In production the app refuses to text an unconfirmed number, and logs why, unless `ALLOW_UNCONFIRMED_BOOKINGS=true`; the booking itself is still saved. The codes cost money too, so on a public form also add a CAPTCHA.
- **The limits are per process.** Five bookings per visitor IP an hour; for bookings that text the number, three per number from one IP and ten per number from all IPs a day (with `CONFIRM_PHONE`, counted once the code checks out); and for codes, three per number from one IP every 15 minutes and ten per number an hour. Counting the number with the IP means a stranger booking with your number can't use up your allowance. With the honeypot field, that is all this app does against abuse. The limits are kept in memory, so they reset on a restart and each serverless instance has its own. Use a shared store (Redis, your database) for them, or add a CAPTCHA.
- **Client IP:** a visitor can put anything in `X-Forwarded-For`, so `lib/clientIp.ts` never reads the leftmost entry. On Vercel and Fly.io it reads the header the platform sets. Elsewhere it takes the entry `TRUSTED_PROXY_HOPS` from the right, and in production you must set it: a bare `next start` fills in `X-Forwarded-For` only when the request has none, so with nothing in front of the app the visitor writes every entry. Set `0` for a bare `next start` (no address is trusted), `1` behind one proxy (Railway, Render, nginx), more if more than one proxy adds to the header. When no address can be trusted, the per-IP limit is skipped (the per-number limits still apply) and the consent record has no `sourceIp`.
- **Your business details:** `BUSINESS_NAME` and `BUSINESS_CONTACT` go into every consent record. In production the app refuses the sample name `Acme Clinic` and any `example.com` address.
- **Set `APP_URL`** to your site's address, so each consent record says where the box was ticked.
- **Use a live key.** Test texts never reach anyone, and consent recorded with a test key covers test sends only. Switch `HONKIO_API_KEY` and `HONKIO_FROM_NUMBER` to live ones and book once yourself to check.

## Settings

| Variable | Required | What it is |
|---|---|---|
| `HONKIO_API_KEY` | Yes | Your HonkIO API key. `mk_test_` to try it, `mk_live_` to send real texts. |
| `HONKIO_FROM_NUMBER` | Yes | The number texts come from, in E.164. With a live key, one of your HonkIO numbers. |
| `BUSINESS_CONTACT` | Yes | How to reach you, shown next to the opt-in box and kept with each consent record: a mailing address plus a phone number, email or website. No `example.com` address in production. |
| `BUSINESS_NAME` | No | Your business name, in the texts and the consent record. Default `Acme Clinic`, which production refuses. |
| `BUSINESS_TIMEZONE` | No | The IANA time zone appointments are booked in. Default `America/Toronto`. |
| `REMINDER_HOURS_BEFORE` | No | Whole hours before the appointment the reminder goes out, 1 to 720. Default `24`. |
| `CONFIRM_PHONE` | Recommended | `true` texts a code to the number first, and sends the booking texts once it is entered. |
| `ALLOW_UNCONFIRMED_BOOKINGS` | No | `true` lets production text numbers that were not confirmed. Only with another guard, such as a CAPTCHA. |
| `APP_URL` | In production | Your site's address, kept with each consent record. |
| `TRUSTED_PROXY_HOPS` | In production, except on Vercel and Fly.io | How many proxies in front of the app add to `X-Forwarded-For`: `0` for a bare `next start` with nothing in front, `1` behind one proxy. Defaults to `1` in development. |
| `HONKIO_WEBHOOK_SECRET` | No | The signing secret of the [webhook](#webhooks-optional). The route answers 404 while it is empty. |
| `BOOKINGS_FILE` | No | Where bookings are kept. Default `data/bookings.json`. |

## Webhooks (optional)

To see opt-outs and replies in your own logs:

1. In the HonkIO dashboard under Webhooks, add `https://<your site>/api/webhooks/honkio` with the events `opt_out.recorded`, `opt_out.reinstated`, `message.received` and `message.failed`.
2. Put the signing secret it shows you in `HONKIO_WEBHOOK_SECRET`.

The route reads the raw body and checks it with `verifyWebhook` from the SDK (HMAC-SHA256 over the timestamp and body, deliveries older than five minutes refused). Anyone can post to it and the signature can only be checked once the body is read, so a body over 1 MB is refused (413) by its `Content-Length`, or as soon as reading passes 1 MB. A delivery can arrive more than once, so deduplicate on `event.id` before acting on one. The route answers 404 while `HONKIO_WEBHOOK_SECRET` is empty.

## Limits worth knowing

- **Scheduling window:** HonkIO schedules a text 1 minute to 30 days ahead, so the form books up to 30 days out. For bookings further ahead, store them and schedule the reminder from a daily job once it is inside the window.
- **Short notice:** a reminder that would be due in under five minutes is skipped; the confirmation covers it.
- **Clock changes:** a time the clocks skip (2:30 a.m. on the night they go forward) is refused with a message to pick another. A time that happens twice (1:30 a.m. on the night they go back) is booked at the first one.
- **Segments:** texts are billed per segment. A plain-text message up to 160 characters is one segment, but one accented letter, curly quote or emoji switches the whole text to a smaller Unicode segment. The date is formatted in plain ASCII for that reason. Keep `BUSINESS_NAME` plain too.
- **Daily cap:** live sending has a daily cap, and new accounts start lower. See [Pricing and limits](https://honkio.ca/docs/sms/pricing-and-limits).

## What it costs

HonkIO is pay per send in CAD, from a prepaid balance, with no monthly plan. Each text is charged per segment, a sending number has a monthly rent, and test mode is free. Current prices are on [honkio.ca/pricing](https://honkio.ca/pricing), and the SDK reads them with `pricing.get()` (`GET /v1/pricing`); `message_cost_cents` is the per-segment rate, in cents CAD:

```ts
const { data } = await honkio().pricing.get(); // honkio() is in lib/honkio.ts
console.log(data?.message_cost_cents);
console.log(data?.verification_cost_cents); // each confirmation code, with CONFIRM_PHONE=true
```

With `CONFIRM_PHONE=true`, each booking that asks for texts also costs one verification code (more if the customer asks for a new one): the per-segment rate plus a verification upcharge. `verification_cost_cents` is a typical one-segment code. Keep `BUSINESS_NAME` short and plain, since the code's text names it.

## Deploy

Any host that runs Next.js and keeps files between requests works as is: a VPS, Railway or Fly.io with a volume. Set the variables from `.env.example` in the host's settings, and point `BOOKINGS_FILE` at the volume.

On Vercel and other serverless hosts the filesystem doesn't last between requests, so replace `JsonFileStore` with a database first. Everything else uses the `BookingStore` interface in `lib/store.ts`, so it is one class to write.

The booking page's URL is the only key to a booking (its id is a random UUID). Booking pages are sent with `Referrer-Policy: no-referrer`, so a link followed from one doesn't pass the URL on, and `X-Robots-Tag: noindex`. Add sign-in or a cancel token before you show bookings to staff or send links by text.

Outside Vercel and Fly.io, set `TRUSTED_PROXY_HOPS` too: the first booking fails with an error in your server log until you do.

## Learn more

- [Sending SMS](https://honkio.ca/docs/sms/sending), including scheduling
- [Consent](https://honkio.ca/docs/sms/consent)
- [Webhook events](https://honkio.ca/docs/webhooks/events) and [signing](https://honkio.ca/docs/webhooks/signing)
- [Node SDK](https://honkio.ca/docs/sdk)

## License

MIT. See [LICENSE](LICENSE).
