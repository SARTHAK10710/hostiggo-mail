# Booking emails: "host has 2 hours to accept"

How the Hostiggo website sends booking emails through Hostiggo Mail. The **website owns the booking
status**. At each change it calls the send API, and Hostiggo Mail delivers the emails, keeps the log, and
tells the website if something fails.

```
Guest books ──► website saves booking (status: pending, expires_at = now + 2h)
                 ├─ host:  booking_request_host     (now)          Accept / Reject buttons
                 ├─ guest: booking_received_guest   (now)          "host has until 4:30 PM"
                 └─ host:  booking_reminder_host    (send_at +90m) cancelled if the host answers first

Host accepts ──► cancel tag booking:<id>  ─►  booking_confirmed_guest + booking_confirmed_host
Host rejects ──► cancel tag booking:<id>  ─►  refund  ─►  booking_declined_guest
2h, no answer ─► cancel tag booking:<id>  ─►  refund  ─►  booking_expired_guest + booking_expired_host
                 (the website's own expiry job does this; Hostiggo Mail doesn't know booking state)
```

## 1. One-time setup (dashboard)

1. **Mailbox.** Connect a dedicated booking mailbox, ideally `bookings@hostiggo.com` on Google Workspace
   with SPF, DKIM and DMARC (see [SPAM-FIX.md](SPAM-FIX.md)). A host who never sees the request in time
   is a lost booking, so inbox placement matters more here than anywhere else. Note its id from
   **Settings → Mailboxes** (or `GET /v1/mailboxes`).
2. **Templates.** **Transactional → Booking emails → Add booking templates** installs 8 templates. Edit
   wording freely; each save is a new version and the API name (slug) stays the same.
3. **API key.** **Settings → API keys & webhooks → New key** with the `messages:send` scope.
4. **Webhook** (recommended). **Add endpoint** with your website URL, e.g.
   `https://hostiggo.com/api/mail-events`. Copy the signing secret.

Website environment variables:

```
HOSTIGGO_MAIL_URL=https://mail.hostiggo.com
HOSTIGGO_MAIL_KEY=hm_live_...
HOSTIGGO_MAIL_MAILBOX_ID=<bookings mailbox id>
HOSTIGGO_MAIL_WEBHOOK_SECRET=whsec_...
```

## 2. The templates and their variables

| API name | To | When |
|---|---|---|
| `booking_request_host` | Host | Guest books |
| `booking_received_guest` | Guest | Guest books |
| `booking_reminder_host` | Host | Scheduled for booked + 90 min; cancelled when the host answers |
| `booking_confirmed_guest` | Guest | Host accepts |
| `booking_confirmed_host` | Host | Host accepts |
| `booking_declined_guest` | Guest | Host rejects |
| `booking_expired_guest` | Guest | 2 hours pass with no answer |
| `booking_expired_host` | Host | 2 hours pass with no answer |

All of them use the same `variables` object, so the website can build it once per booking:

```json
{
  "booking":  { "id": "HG-1042", "url": "https://hostiggo.com/trips/HG-1042" },
  "guest":    { "first_name": "Priya", "name": "Priya Sharma", "count": "2 guests" },
  "host":     { "first_name": "Rohan" },
  "property": { "name": "Pine View Cottage", "city": "Manali", "address": "Old Manali Road, Manali" },
  "stay":     { "check_in": "Fri 12 Dec 2026", "check_out": "Sun 14 Dec 2026", "nights": "2 nights" },
  "amount":   { "total": "₹6,400", "payout": "₹5,760" },
  "respond_by": "4:30 PM IST today",
  "links": {
    "accept":  "https://hostiggo.com/host/bookings/HG-1042/respond?action=accept&t=<signed token>",
    "reject":  "https://hostiggo.com/host/bookings/HG-1042/respond?action=reject&t=<signed token>",
    "booking": "https://hostiggo.com/host/bookings/HG-1042",
    "search":  "https://hostiggo.com/search?city=Manali&from=2026-12-12&to=2026-12-14"
  },
  "refund": { "amount": "₹6,400", "eta": "5-7 business days" }
}
```

- **Format values on the website**: dates and `respond_by` in the recipient's time zone, amounts with
  the currency symbol. Templates only place them.
- **Missing values are refused.** If a template uses a value you didn't send (and it has no default),
  the API answers `422 missing_variables` with the list, and nothing is sent. A booking email with a
  blank date or a dead Accept button is worse than an error you can see.

## 3. Website code

A small client (TypeScript, works in Next.js route handlers / server actions or a Supabase Edge Function):

```ts
// lib/hostiggoMail.ts
const BASE = process.env.HOSTIGGO_MAIL_URL!;
const headers = { Authorization: `Bearer ${process.env.HOSTIGGO_MAIL_KEY}`, 'Content-Type': 'application/json' };
const mailbox_id = process.env.HOSTIGGO_MAIL_MAILBOX_ID;

type Msg = { to: string; template: string; variables: object; idempotency_key: string; send_at?: string };

export async function sendBookingEmails(bookingId: string, messages: Msg[]) {
  const res = await fetch(`${BASE}/v1/messages/batch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: messages.map((m) => ({ ...m, mailbox_id, tags: [`booking:${bookingId}`], metadata: { booking_id: bookingId } })),
    }),
  });
  if (!res.ok) throw new Error(`Hostiggo Mail ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Stop anything still queued for this booking (the host reminder). */
export async function cancelBookingEmails(bookingId: string) {
  await fetch(`${BASE}/v1/sends/cancel`, { method: 'POST', headers, body: JSON.stringify({ tag: `booking:${bookingId}` }) });
}
```

Calling it at each step (`v` is the variables object above):

```ts
// Guest books
await sendBookingEmails(b.id, [
  { to: host.email,  template: 'booking_request_host',   variables: v, idempotency_key: `${b.id}:host-request` },
  { to: guest.email, template: 'booking_received_guest', variables: v, idempotency_key: `${b.id}:guest-received` },
  { to: host.email,  template: 'booking_reminder_host',  variables: v, idempotency_key: `${b.id}:host-reminder`,
    send_at: new Date(b.created_at.getTime() + 90 * 60_000).toISOString() },
]);

// Host accepts
await cancelBookingEmails(b.id);
await sendBookingEmails(b.id, [
  { to: guest.email, template: 'booking_confirmed_guest', variables: v, idempotency_key: `${b.id}:guest-confirmed` },
  { to: host.email,  template: 'booking_confirmed_host',  variables: v, idempotency_key: `${b.id}:host-confirmed` },
]);

// Host rejects (after starting the refund)
await cancelBookingEmails(b.id);
await sendBookingEmails(b.id, [
  { to: guest.email, template: 'booking_declined_guest', variables: v, idempotency_key: `${b.id}:guest-declined` },
]);

// Expiry job: bookings still pending after expires_at (after cancelling + starting the refund)
await cancelBookingEmails(b.id);
await sendBookingEmails(b.id, [
  { to: guest.email, template: 'booking_expired_guest', variables: v, idempotency_key: `${b.id}:guest-expired` },
  { to: host.email,  template: 'booking_expired_host',  variables: v, idempotency_key: `${b.id}:host-expired` },
]);
```

**Retries are safe.** Each message has a fixed `idempotency_key` (`<booking>:<step>`), so if the website
times out and calls again, nothing is sent twice. A batch is all-or-nothing: if one message is invalid,
none are queued.

**Don't block the booking on email.** Save the booking first, then send. If the call fails, retry from a
queue or cron; the idempotency keys make that safe.

## 4. Accept / Reject links: confirm on a page, never on the click

Email security scanners (Outlook Safe Links, corporate gateways, some antivirus) **open every link in an
email automatically**. If `GET .../respond?action=accept` accepted the booking, a scanner could accept
or reject it before the host even reads the email.

- The link opens a page on hostiggo.com showing the booking and a **Confirm accept** / **Confirm reject**
  button. The status changes only on that button's `POST`.
- Put a signed, expiring token in the link (`t=`) so the host doesn't have to sign in from their phone,
  and check that the booking is still `pending` (it may have expired or already been answered).
- After the deadline, the page should say the request expired instead of showing the buttons.

## 5. Webhooks: hear about failures within seconds

With the 2-hour window there's no time to discover a bounced host email the next day. Hostiggo Mail
POSTs a signed event to your endpoint for transactional sends. The default events are
`send.failed`, `send.suppressed`, `send.bounced` and `send.unknown`.

```json
{
  "id": "5d0c…", "type": "send.suppressed", "created_at": "2026-12-12T09:02:11Z",
  "data": {
    "send_id": "9a1e…", "to": "host@example.com", "status": "suppressed",
    "error_code": "suppressed_bounced", "error": "Recipient address bounced or complained previously",
    "template": "booking_request_host", "idempotency_key": "HG-1042:host-request",
    "tags": ["booking:HG-1042"], "metadata": { "booking_id": "HG-1042" }
  }
}
```

Verify the signature before trusting it (Next.js route handler):

```ts
// app/api/mail-events/route.ts
import crypto from 'node:crypto';

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get('hostiggo-signature') ?? '';
  const [, t, v1] = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/) ?? [];
  const expected = crypto.createHmac('sha256', process.env.HOSTIGGO_MAIL_WEBHOOK_SECRET!).update(`${t}.${raw}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  if (!v1 || !fresh || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) {
    return new Response('bad signature', { status: 400 });
  }
  const event = JSON.parse(raw);
  const bookingId = event.data?.metadata?.booking_id;
  if (event.data?.template === 'booking_request_host' && bookingId) {
    // e.g. text the host the accept/reject link, or alert the ops team
  }
  return new Response('ok'); // any 2xx; other answers are retried for about an hour
}
```

Deliveries and retries are visible under **Settings → API keys & webhooks → Show recent deliveries**,
and **Send test** posts a signed `ping` event.

## 6. What Hostiggo Mail does for you

| Concern | How it's handled |
|---|---|
| Duplicate emails on retries | Idempotency key per message |
| Marketing campaign uses up the daily limit | 20% of each mailbox's daily limit is reserved for transactional mail (`TRANSACTIONAL_RESERVE_PERCENT`), and transactional jobs are picked up before marketing ones |
| Blank details | `422 missing_variables`, nothing sent |
| Reminder after the host already answered | Scheduled with `send_at`, cancelled by tag |
| Finding everything for one booking | Dashboard log filter `booking:HG-1042`, or `GET /v1/sends?tag=booking:HG-1042` |
| Address that bounced before | Blocked (`suppressed`) and reported by webhook |
| Unsubscribe line | Never added to transactional mail |

## 7. Limits to know

- Gmail reports **accepted**, not delivered or read. A host may still miss an email that went to Spam,
  so keep an in-app or SMS notification for new requests as well.
- Scheduled sends can be at most 30 days ahead.
- A personal Gmail mailbox allows about 500 emails a day; Google Workspace about 2,000.
