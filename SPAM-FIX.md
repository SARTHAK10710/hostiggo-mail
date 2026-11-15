# Fixing "emails land in Spam"

What we saw: test emails sent from a personal Gmail through Hostiggo Mail landed in **Primary for
one recipient and Spam for the others**. That pattern means nothing is broken. Gmail decides *per
recipient*, and a brand-new sender with no history gets filtered for most people. This guide goes
from the quickest fixes to the permanent ones.

---

## Step 0: Find out *why* Gmail filtered it

1. Open the email in the recipient's **Spam** folder.
2. Read the grey banner at the top (for example *"This message is similar to messages that were
   identified as spam in the past"* or *"…can't verify that this message came from…"*).
3. Click **⋮ → Show original** and check the **SPF / DKIM / DMARC** lines at the top.

| What you see | Most likely cause | Go to |
|---|---|---|
| "Similar to messages identified as spam" | New sender / promotional-looking content | Steps 1, 2, 3 |
| "Gmail couldn't verify this was sent by…" / DKIM or DMARC **FAIL** | Domain authentication | Step 5 |
| "Be careful with this message" / phishing warning | Brand name on a personal address, link mismatch | Step 2 |
| Lots of people reporting spam | No consent / no easy unsubscribe | Step 4 |

---

## Step 1: Train the inboxes (works today, 5 minutes)

Ask each recipient to:

1. Open the email in Spam and click **Report not spam**.
2. **Reply** to it, even just "got it". A reply is the strongest positive signal Gmail has.
3. **Add your address to Google Contacts.**

After this, future emails to that person usually land in the inbox. This is why one recipient got
it in Primary: they already had a history with your address.

---

## Step 2: Look like a person, not a bulk blast

New senders are judged mostly on content and identity.

- **From name:** on a personal `@gmail.com` address, use a person, e.g.
  `Sarthak from Hostiggo`, not just `Hostiggo`. A brand name on a free mailbox looks like
  impersonation. (Template → *From name*.)
- **Plain text first:** for the first few weeks, send short plain-text emails written like a
  personal note. Leave the HTML body empty or keep it minimal.
- **Links:** one link at most, to your own real website. No link shorteners, no raw IP addresses,
  no `localhost` (the app no longer adds localhost links).
- **Avoid:** ALL CAPS, lots of `!!!`, "FREE", "Act now", "Limited offer", big images with little
  text, image-only emails, attachments.
- **Subject:** specific and honest, e.g. "Your stay in Goa next week", not "Amazing deals inside!!!".
- **Personalise:** use `{{ contact.first_name | default: "there" }}` so every email differs.

---

## Step 3: Send like a new sender (warm-up)

- Start with **people who know you** and are likely to open and reply.
- Send **in small batches**: 10–20/day for the first week, then roughly double each week if spam
  placement stays low. **The app now does this for you**: new mailboxes warm up automatically
  (20/day, doubling every 7 days up to the mailbox's Daily limit; `WARMUP_DEFAULT=true`). Turn it on or
  off per mailbox under *Deliverability → Daily limit*. Sends over today's cap wait in the queue.
- Don't send the same campaign to everyone at once from a brand-new mailbox.
- Keep **bounces under 2%** and **spam complaints under 0.1%** (Deliverability page shows both).
  The app automatically suppresses bounced and complained addresses.

---

## Step 4: Consent and unsubscribe (protects your reputation)

- Only email people who **opted in**. The app enforces this for marketing email; record an honest
  consent source.
- **Make leaving easy.** If people can't unsubscribe, they click "Report spam", and spam reports
  are what really hurt you.
  - The visible unsubscribe line is currently **off** (`UNSUBSCRIBE_FOOTER=false` in `.env`). Turn it
    back on (`true`) once the app runs on a public HTTPS address (see IMPROVE.md 1.2), then restart.
  - The hidden `List-Unsubscribe` header is always sent, so Gmail can show its own "Unsubscribe"
    link next to your name.
  - While the app runs on your own computer, unsubscribe works by reply. With reply tracking on, a
    reply that is just "unsubscribe" (or "stop", "remove me"…) is **processed automatically**: the sender is
    suppressed and opted out. Without reply tracking, add them in **Deliverability → Add suppression**.

---

## Step 5: The permanent fix: your own domain with SPF, DKIM, DMARC

A personal Gmail is fine for testing a handful of people, but it will never be reliable for real
marketing. Send from **Google Workspace on your domain** (e.g. `team@hostiggo.com`).

### 5.1 Set up Workspace
1. Sign up for Google Workspace with your domain and verify ownership.
2. ⚠️ If the domain already has email elsewhere (Zoho, Hostinger, GoDaddy…), switching **MX** records
   moves *all* the domain's incoming mail to Google. Plan the switch first.
3. Create the sending user, e.g. `team@hostiggo.com`.

### 5.2 DNS records (at your domain registrar / DNS host)

| Type | Host / Name | Value | Purpose |
|---|---|---|---|
| MX | `@` | The records Google shows during setup (e.g. `smtp.google.com`, priority 1) | Receive mail |
| TXT | `@` | `v=spf1 include:_spf.google.com ~all` | SPF: Google may send for your domain |
| TXT | `google._domainkey` | *(generated in Admin console → Apps → Google Workspace → Gmail → **Authenticate email** → 2048-bit)* then click **Start authentication** | DKIM: cryptographic signature |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@hostiggo.com` | DMARC: policy + reports |

- Only **one** SPF record per domain. If one already exists, merge the `include:` into it.
- After 2–4 weeks of clean reports, tighten DMARC to `p=quarantine`, later `p=reject`.

### 5.3 Connect it to Hostiggo Mail
1. Easiest and best: in Google Cloud, create the OAuth project **inside your Workspace
   organisation** with audience **Internal**. No test users, no "unverified app" warning, no 7-day
   expiry. Put the new client ID/secret in `.env` and restart.
   (Quick alternative: add `team@hostiggo.com` as a test user on the current project.)
2. Dashboard → **Deliverability**: disconnect the personal Gmail, **Connect Gmail account** with the
   Workspace user, and raise **Daily limit** (Workspace allows ~2,000/day; stay well below).
3. In each template set **From name** to `Hostiggo` (now it matches the domain) and **Reply-to** if needed.

### 5.4 Verify
Send a test to a Gmail address → open it → **⋮ → Show original**. You want:
```
SPF:   PASS
DKIM:  PASS  with domain hostiggo.com
DMARC: PASS
```
Then register the domain in **Google Postmaster Tools** (postmaster.google.com) to watch spam
rate and domain reputation over time.

---

## Step 6: For large marketing lists, use an email service provider

Google Workspace is for person-to-person and transactional mail; its policies don't allow bulk
marketing. When lists grow into the thousands, add an ESP (Amazon SES, Postmark, Resend, SendGrid)
behind the app's `EmailProvider` interface, on a sending subdomain such as `mail.hostiggo.com` with
its own SPF/DKIM. See IMPROVE.md 2.6.

---

## Quick checklist

- [ ] Recipients clicked **Not spam** and replied (Step 1)
- [ ] From name is a person on personal Gmail, or the brand on your own domain (Step 2 / 5)
- [ ] Short, plain, personal content; one real link; no localhost links (Step 2)
- [ ] Small batches, growing slowly; bounces < 2%, complaints < 0.1% (Step 3)
- [ ] Only opted-in contacts; easy unsubscribe (Step 4)
- [ ] Workspace + SPF + DKIM + DMARC all **PASS** in *Show original* (Step 5)
- [ ] Domain added to Google Postmaster Tools (Step 5.4)
