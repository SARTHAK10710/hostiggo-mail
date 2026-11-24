import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { escapeHtml } from '../lib/template.js';

/**
 * Public Privacy Policy, Terms of Service and Support pages.
 * Google requires a privacy policy (with the Limited Use disclosure) and a homepage linking to it
 * before verifying an app that uses Gmail scopes. These are honest starting templates that match
 * what the code actually does; have them reviewed before launch.
 */
const UPDATED = '24 November 2026';

function page(ctx: Ctx, title: string, body: string) {
  const company = escapeHtml(ctx.config.COMPANY_NAME);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${company} Mail</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#f8fafc;color:#0f172a;font:15px/1.65 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
  header{background:#0f172a;color:#fff;padding:14px 20px}
  header a{color:#fff;text-decoration:none;font-weight:600}
  main{max-width:760px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:28px;line-height:1.2;margin:0 0 4px} h2{font-size:18px;margin:32px 0 8px}
  .muted{color:#64748b;font-size:13px} a{color:#4f46e5}
  .note{background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:12px 14px;font-size:14px}
  footer{max-width:760px;margin:0 auto;padding:0 20px 40px;color:#64748b;font-size:13px}
  footer a{margin-right:14px}
</style></head><body>
<header><a href="/">${company} Mail</a></header>
<main><h1>${escapeHtml(title)}</h1><p class="muted">Last updated ${UPDATED}</p>${body}</main>
<footer><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></footer>
</body></html>`;
}

function contact(ctx: Ctx) {
  const e = ctx.config.SUPPORT_EMAIL;
  return e ? `<a href="mailto:${escapeHtml(e)}">${escapeHtml(e)}</a>` : 'the support address shown in your workspace';
}

export function legalRoutes(app: FastifyInstance, ctx: Ctx) {
  const company = () => escapeHtml(ctx.config.COMPANY_NAME);

  app.get('/privacy', async (_req, reply) => {
    reply.type('text/html').header('cache-control', 'public, max-age=300');
    return page(ctx, 'Privacy Policy', `
<p>${company()} Mail ("the Service") helps ${company()} teams send transactional and permission-based marketing email
from their own Gmail or Google Workspace mailboxes. This policy explains what data the Service handles and why.</p>

<h2>Data we handle</h2>
<ul>
  <li><b>Account data</b>: your name, email address and a one-way hash of your password; workspace membership and role.</li>
  <li><b>Contact data you add</b>: recipients' email addresses, names, custom fields, list membership, and consent records
  (status, source and time). You are responsible for having permission to email them.</li>
  <li><b>Message data</b>: templates you write, and a log of each message sent (recipient, subject, status, provider message id,
  timestamps). Message bodies sent ad hoc through the API are deleted 30 days after sending.</li>
  <li><b>Operational data</b>: an audit log of sensitive actions (connections, keys, publishes) and technical logs without message content.</li>
</ul>

<h2>Google user data</h2>
<p>When you connect a Gmail or Google Workspace account, you choose to grant the Service access through Google OAuth:</p>
<ul>
  <li><b>Basic profile (email, name)</b>: to identify which mailbox is connected.</li>
  <li><b>Send email on your behalf</b> (<code>gmail.send</code>): to send only the messages you or your automations request.</li>
  <li><b>View email message metadata</b> (<code>gmail.metadata</code>, only if reply tracking is enabled): to read message
  <i>headers</i> (sender, recipients, subject, date, thread and message identifiers) so the Service can recognise replies and bounces
  to messages it sent. The Service cannot read message bodies or attachments with this permission.</li>
</ul>
<p>Refresh tokens are encrypted at rest (AES-256-GCM); short-lived access tokens are kept only in memory. Disconnecting a mailbox
revokes the Service's access with Google and deletes the stored token.</p>
<div class="note">${company()} Mail's use and transfer to any other app of information received from Google APIs will adhere to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the
Limited Use requirements.</div>
<p>Specifically, Google user data is used only to provide and improve the user-facing features described above; it is not used for
advertising, not sold, not used to train generalised AI models, and not read by humans except with your explicit consent, for
security purposes (such as investigating abuse), to comply with law, or when aggregated and anonymised for internal operations.</p>

<h2>Sharing</h2>
<p>We do not sell personal data. Data is processed by our hosting and database providers and by Google (to deliver email), only
to run the Service.</p>

<h2>Retention and deletion</h2>
<ul>
  <li>Unsubscribe, bounce and complaint records are kept so that those addresses are never emailed again.</li>
  <li>Deleting a contact stops all messages to them. To delete an account, a workspace, or all data about an email address,
  contact ${contact(ctx)}.</li>
  <li>You can revoke Google access at any time from the Service (Disconnect) or at
  <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</li>
</ul>

<h2>Recipients</h2>
<p>If you received an email sent with the Service, you can unsubscribe using the link or reply in that email, or contact the
sender directly. To ask about data held about you, contact ${contact(ctx)}.</p>

<h2>Security</h2>
<p>Encrypted connections, encrypted OAuth tokens, hashed passwords and API keys, per-workspace access control, rate limiting and an audit log.</p>

<h2>Changes and contact</h2>
<p>We will update this page when practices change. Questions: ${contact(ctx)}.</p>`);
  });

  app.get('/terms', async (_req, reply) => {
    reply.type('text/html').header('cache-control', 'public, max-age=300');
    return page(ctx, 'Terms of Service', `
<p>By creating an account or connecting a mailbox to ${company()} Mail ("the Service") you agree to these terms.</p>

<h2>Acceptable use</h2>
<ul>
  <li>Email only people who gave permission (marketing) or who have a relationship with you that the message relates to (transactional).</li>
  <li>No purchased, rented or scraped lists. No misleading senders, subjects or content. Honour unsubscribe requests promptly.</li>
  <li>Comply with applicable law (for example CAN-SPAM, GDPR, CASL and India's IT Act) and with Google's policies and sending limits.</li>
  <li>Do not use the Service for phishing, malware, harassment or illegal content.</li>
</ul>

<h2>Your account and data</h2>
<p>You are responsible for your credentials, your workspace members and the contact data you upload. You keep ownership of your data.</p>

<h2>Suspension</h2>
<p>We may pause sending or suspend accounts that breach these terms, generate high bounce or complaint rates, or put the Service or
recipients at risk.</p>

<h2>Availability</h2>
<p>The Service is provided "as is". Email delivery depends on third parties (such as Google and recipients' providers) and inbox
placement is never guaranteed.</p>

<h2>Ending use</h2>
<p>You can disconnect mailboxes and ask for deletion of your data at any time by contacting ${contact(ctx)}.</p>

<h2>Contact</h2>
<p>${contact(ctx)}</p>`);
  });

  app.get('/support', async (_req, reply) => {
    reply.type('text/html').header('cache-control', 'public, max-age=300');
    return page(ctx, 'Support', `
<p>Need help with ${company()} Mail? Email ${contact(ctx)} and include your workspace name and, for a failed message, the send id shown
in its details panel.</p>
<h2>Common questions</h2>
<ul>
  <li><b>Connecting Gmail fails with "access_denied".</b> While the app is in Google's testing mode, your address must be added as a
  test user by the administrator.</li>
  <li><b>My messages land in Spam.</b> See the deliverability guidance in your workspace (Deliverability page); sending from your
  own domain with SPF, DKIM and DMARC helps most.</li>
  <li><b>I want to stop receiving emails.</b> Use the unsubscribe link or reply "unsubscribe" to the message.</li>
  <li><b>Delete my data.</b> Email ${contact(ctx)} from the address concerned.</li>
</ul>
<p><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a></p>`);
  });
}
