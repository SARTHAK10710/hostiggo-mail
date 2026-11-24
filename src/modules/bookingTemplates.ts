/**
 * Starter pack: the emails for Hostiggo's "host has 2 hours to accept" booking flow.
 * Installed per workspace from the dashboard (Transactional → Booking emails) or
 * POST /v1/templates/starter/booking. Each template has a stable slug the website sends by.
 *
 * The website formats every value (dates in the recipient's time zone, amounts with the
 * currency symbol) and passes it in `variables`; templates only place them.
 */

export interface StarterTemplate {
  slug: string;
  name: string;
  /** Who it goes to and when the website should send it (shown in the dashboard). */
  when: string;
  subject: string;
  html_body: string;
  text_body: string;
  sample_variables: Record<string, unknown>;
}

const SAMPLE = {
  booking: { id: 'HG-1042', url: 'https://hostiggo.com/trips/HG-1042' },
  guest: { first_name: 'Priya', name: 'Priya Sharma', count: '2 guests' },
  host: { first_name: 'Rohan' },
  property: { name: 'Pine View Cottage', city: 'Manali', address: 'Old Manali Road, Manali, Himachal Pradesh' },
  stay: { check_in: 'Fri 12 Dec 2026', check_out: 'Sun 14 Dec 2026', nights: '2 nights' },
  amount: { total: 'Rs 6,400', payout: 'Rs 5,760' },
  respond_by: '4:30 PM IST today',
  links: {
    accept: 'https://hostiggo.com/host/bookings/HG-1042/respond?action=accept',
    reject: 'https://hostiggo.com/host/bookings/HG-1042/respond?action=reject',
    booking: 'https://hostiggo.com/host/bookings/HG-1042',
    search: 'https://hostiggo.com/search?city=Manali&from=2026-12-12&to=2026-12-14',
  },
  refund: { amount: 'Rs 6,400', eta: '5-7 business days' },
};

// ── Layout helpers (inline styles: email clients ignore <style> blocks unevenly) ──
const BRAND = '#0f766e';

function layout(preheader: string, inner: string) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<tr><td style="padding:20px 28px;border-bottom:1px solid #e4e4e7;font-size:18px;font-weight:bold;color:${BRAND}">Hostiggo</td></tr>
<tr><td style="padding:24px 28px;font-size:15px;line-height:1.55">
${inner}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a">Booking {{ booking.id }} &middot; You're receiving this because of a booking on Hostiggo.</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

const button = (href: string, label: string, color = BRAND) =>
  `<a href="${href}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;margin:4px 8px 4px 0">${label}</a>`;

const outlineButton = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#ffffff;color:#b91c1c;text-decoration:none;font-weight:bold;padding:11px 21px;border-radius:8px;border:1px solid #fca5a5;margin:4px 8px 4px 0">${label}</a>`;

function summary(rows: [string, string][]) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px">
${rows.map(([k, v]) => `<tr><td style="padding:8px 14px;font-size:13px;color:#71717a;width:38%">${k}</td><td style="padding:8px 14px;font-size:14px;font-weight:bold">${v}</td></tr>`).join('\n')}
</table>`;
}

const stayRows: [string, string][] = [
  ['Stay', '{{ property.name }}'],
  ['Check-in', '{{ stay.check_in }}'],
  ['Check-out', '{{ stay.check_out }}'],
  ['Guests', '{{ guest.count }}'],
];

const stayText = `Stay:      {{ property.name }}
Check-in:  {{ stay.check_in }}
Check-out: {{ stay.check_out }}
Guests:    {{ guest.count }}`;

export const BOOKING_TEMPLATES: StarterTemplate[] = [
  {
    slug: 'booking_request_host',
    name: 'Booking: new request (to host)',
    when: 'To the host, the moment a guest books. Includes Accept / Reject buttons.',
    subject: 'New booking request from {{ guest.name }}: please respond by {{ respond_by }}',
    html_body: layout(
      '{{ guest.name }} wants to stay {{ stay.check_in }} to {{ stay.check_out }}. Accept or reject by {{ respond_by }}.',
      `<p>Hi {{ host.first_name | default: "there" }},</p>
<p><strong>{{ guest.name }}</strong> has requested to book <strong>{{ property.name }}</strong>.</p>
${summary([...stayRows, ['You earn', '{{ amount.payout }}']])}
<p style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 14px;font-size:14px">Please respond by <strong>{{ respond_by }}</strong>. If you don't, the request expires and the guest is refunded.</p>
<p>${button('{{ links.accept }}', 'Accept booking')}${outlineButton('{{ links.reject }}', 'Reject')}</p>
<p style="font-size:13px;color:#71717a">Each button opens a page on Hostiggo where you confirm your choice. You can also manage this request from your <a href="{{ links.booking }}" style="color:${BRAND}">host dashboard</a>.</p>`,
    ),
    text_body: `Hi {{ host.first_name | default: "there" }},

{{ guest.name }} has requested to book {{ property.name }}.

${stayText}
You earn:  {{ amount.payout }}

Please respond by {{ respond_by }}. If you don't, the request expires and the guest is refunded.

Accept: {{ links.accept }}
Reject: {{ links.reject }}

Each link opens a page on Hostiggo where you confirm your choice.
Booking {{ booking.id }}: {{ links.booking }}
`,
    sample_variables: SAMPLE,
  },
  {
    slug: 'booking_reminder_host',
    name: 'Booking: reminder (to host)',
    when: 'To the host, about 30 minutes before the deadline if they have not answered. Schedule it with send_at and cancel it by tag when they respond.',
    subject: 'Reminder: {{ guest.name }}\'s booking request expires at {{ respond_by }}',
    html_body: layout(
      'Only a little time left to accept or reject this booking.',
      `<p>Hi {{ host.first_name | default: "there" }},</p>
<p>You haven't responded to <strong>{{ guest.name }}</strong>'s request for <strong>{{ property.name }}</strong> ({{ stay.check_in }} to {{ stay.check_out }}, {{ amount.payout }} for you).</p>
<p>The request expires at <strong>{{ respond_by }}</strong>.</p>
<p>${button('{{ links.accept }}', 'Accept booking')}${outlineButton('{{ links.reject }}', 'Reject')}</p>`,
    ),
    text_body: `Hi {{ host.first_name | default: "there" }},

You haven't responded to {{ guest.name }}'s request for {{ property.name }} ({{ stay.check_in }} to {{ stay.check_out }}, {{ amount.payout }} for you).

The request expires at {{ respond_by }}.

Accept: {{ links.accept }}
Reject: {{ links.reject }}
`,
    sample_variables: SAMPLE,
  },
  {
    slug: 'booking_received_guest',
    name: 'Booking: request received (to guest)',
    when: 'To the guest, the moment they book. Says the host has until the deadline to confirm.',
    subject: 'Booking request sent: {{ property.name }}, {{ stay.check_in }}',
    html_body: layout(
      'Your request is with the host. You will hear back by {{ respond_by }}.',
      `<p>Hi {{ guest.first_name | default: "there" }},</p>
<p>Thanks for booking with Hostiggo. We've sent your request to {{ host.first_name | default: "the host" }}, who has until <strong>{{ respond_by }}</strong> to confirm.</p>
${summary([...stayRows, ['Total paid', '{{ amount.total }}'], ['Status', 'Waiting for host']])}
<p>We'll email you as soon as the host responds. If they can't host you, or don't respond in time, you'll get a <strong>full refund</strong> automatically.</p>
<p>${button('{{ booking.url }}', 'View booking')}</p>`,
    ),
    text_body: `Hi {{ guest.first_name | default: "there" }},

Thanks for booking with Hostiggo. We've sent your request to {{ host.first_name | default: "the host" }}, who has until {{ respond_by }} to confirm.

${stayText}
Total paid: {{ amount.total }}
Status:     Waiting for host

We'll email you as soon as the host responds. If they can't host you, or don't respond in time, you'll get a full refund automatically.

View booking: {{ booking.url }}
`,
    sample_variables: SAMPLE,
  },
  {
    slug: 'booking_confirmed_guest',
    name: 'Booking: confirmed (to guest)',
    when: 'To the guest, when the host accepts.',
    subject: 'Confirmed: your stay at {{ property.name }}, {{ stay.check_in }}',
    html_body: layout(
      'Your host accepted your booking. See your stay details.',
      `<p>Hi {{ guest.first_name | default: "there" }},</p>
<p style="font-size:17px"><strong>Good news: {{ host.first_name | default: "your host" }} accepted your booking.</strong></p>
${summary([...stayRows, ['Address', '{{ property.address | default: "Shared in your booking page" }}'], ['Total paid', '{{ amount.total }}']])}
<p>Your booking page has directions, check-in instructions and a way to message your host.</p>
<p>${button('{{ booking.url }}', 'View your booking')}</p>`,
    ),
    text_body: `Hi {{ guest.first_name | default: "there" }},

Good news: {{ host.first_name | default: "your host" }} accepted your booking.

${stayText}
Address:   {{ property.address | default: "Shared in your booking page" }}
Total paid: {{ amount.total }}

Your booking page has directions, check-in instructions and a way to message your host:
{{ booking.url }}
`,
    sample_variables: SAMPLE,
  },
  {
    slug: 'booking_confirmed_host',
    name: 'Booking: confirmed (to host)',
    when: 'To the host, right after they accept, as their record of the booking.',
    subject: 'You accepted {{ guest.name }}: {{ stay.check_in }} to {{ stay.check_out }}',
    html_body: layout(
      'Booking confirmed. Here are the details for your records.',
      `<p>Hi {{ host.first_name | default: "there" }},</p>
<p>You've accepted <strong>{{ guest.name }}</strong>'s booking. We've let them know.</p>
${summary([...stayRows, ['You earn', '{{ amount.payout }}']])}
<p>${button('{{ links.booking }}', 'Open booking')}</p>`,
    ),
    text_body: `Hi {{ host.first_name | default: "there" }},

You've accepted {{ guest.name }}'s booking. We've let them know.

${stayText}
You earn:  {{ amount.payout }}

Open booking: {{ links.booking }}
`,
    sample_variables: SAMPLE,
  },
  {
    slug: 'booking_declined_guest',
    name: 'Booking: declined (to guest)',
    when: 'To the guest, when the host rejects. Explains the refund and links to similar stays.',
    subject: 'Your booking at {{ property.name }} wasn\'t accepted: full refund on its way',
    html_body: layout(
      'The host could not accept your dates. Your refund has started.',
      `<p>Hi {{ guest.first_name | default: "there" }},</p>
<p>Sorry, {{ host.first_name | default: "the host" }} couldn't accept your request for <strong>{{ property.name }}</strong> ({{ stay.check_in }} to {{ stay.check_out }}).</p>
${summary([['Refund', '{{ refund.amount }}'], ['Arrives in', '{{ refund.eta | default: "5-7 business days" }}'], ['Refunded to', 'Your original payment method']])}
<p>There are other stays available for your dates:</p>
<p>${button('{{ links.search }}', 'Find another stay')}</p>`,
    ),
    text_body: `Hi {{ guest.first_name | default: "there" }},

Sorry, {{ host.first_name | default: "the host" }} couldn't accept your request for {{ property.name }} ({{ stay.check_in }} to {{ stay.check_out }}).

Refund:      {{ refund.amount }}
Arrives in:  {{ refund.eta | default: "5-7 business days" }}
Refunded to: Your original payment method

Find another stay for your dates: {{ links.search }}
`,
    sample_variables: SAMPLE,
  },
  {
    slug: 'booking_expired_guest',
    name: 'Booking: expired (to guest)',
    when: 'To the guest, when the host did not respond in time. Send it from the same job that cancels the booking and starts the refund.',
    subject: 'Your booking request expired: full refund on its way',
    html_body: layout(
      'The host did not respond in time. Your refund has started.',
      `<p>Hi {{ guest.first_name | default: "there" }},</p>
<p>{{ host.first_name | default: "The host" }} didn't respond to your request for <strong>{{ property.name }}</strong> in time, so we've cancelled it. You won't be charged.</p>
${summary([['Refund', '{{ refund.amount }}'], ['Arrives in', '{{ refund.eta | default: "5-7 business days" }}']])}
<p>${button('{{ links.search }}', 'Find another stay')}</p>`,
    ),
    text_body: `Hi {{ guest.first_name | default: "there" }},

{{ host.first_name | default: "The host" }} didn't respond to your request for {{ property.name }} in time, so we've cancelled it. You won't be charged.

Refund:     {{ refund.amount }}
Arrives in: {{ refund.eta | default: "5-7 business days" }}

Find another stay for your dates: {{ links.search }}
`,
    sample_variables: SAMPLE,
  },
  {
    slug: 'booking_expired_host',
    name: 'Booking: expired (to host)',
    when: 'To the host, when their request lapsed without an answer.',
    subject: 'You missed a booking request from {{ guest.name }}',
    html_body: layout(
      'The request expired because there was no response in time.',
      `<p>Hi {{ host.first_name | default: "there" }},</p>
<p>{{ guest.name }}'s request for <strong>{{ property.name }}</strong> ({{ stay.check_in }} to {{ stay.check_out }}) expired because it wasn't answered by {{ respond_by }}. The guest has been refunded.</p>
<p>Keeping your calendar up to date helps you avoid missed requests.</p>
<p>${button('{{ links.booking }}', 'Open host dashboard')}</p>`,
    ),
    text_body: `Hi {{ host.first_name | default: "there" }},

{{ guest.name }}'s request for {{ property.name }} ({{ stay.check_in }} to {{ stay.check_out }}) expired because it wasn't answered by {{ respond_by }}. The guest has been refunded.

Keeping your calendar up to date helps you avoid missed requests.

Open host dashboard: {{ links.booking }}
`,
    sample_variables: SAMPLE,
  },
];
