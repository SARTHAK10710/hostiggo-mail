# Google OAuth verification (for public users)

While the app is in **Testing**, only listed test users (max 100) can connect, and their access expires
every 7 days. To let anyone connect, Google must verify the app. What's needed depends on the scopes:

| Scope | Google class | Requirement |
|---|---|---|
| `openid`, `email`, `profile` | non-sensitive | none |
| `gmail.send` | **sensitive** | brand + scope verification (a few days to weeks) |
| `gmail.metadata` (reply tracking) | **restricted** | verification **plus an annual third-party security assessment (CASA)** |

**Shortcut for an internal tool:** if everyone who connects is on your Google Workspace domain, create the
OAuth project inside that Workspace organisation and set the audience to **Internal**. No verification,
no test-user list, no 7-day expiry.

## Before submitting
- [ ] App hosted on your own verified domain over HTTPS (see DEPLOY.md).
- [ ] Domain verified in Google Search Console and listed as an authorised domain on the consent screen.
- [ ] Home page link: `https://<domain>` (the sign-in page links to Privacy, Terms and Support).
- [ ] Privacy policy: `https://<domain>/privacy`. It already includes the required **Limited Use** statement
      and explains each Gmail scope; have it reviewed and set `SUPPORT_EMAIL` and `COMPANY_NAME`.
- [ ] Terms: `https://<domain>/terms`.
- [ ] App name, logo (120×120) and support email match your brand on the consent screen.
- [ ] Request **only** the scopes you use: keep `GMAIL_REPLY_TRACKING=false` if you don't want the restricted-scope review.

## Scope justifications (paste and adapt)
**gmail.send**: "Hostiggo Mail lets a business send booking confirmations, account notices and permission-based
emails from its own Gmail/Workspace mailbox. The app sends only messages the user writes or schedules
in the dashboard; it never sends on its own."

**gmail.metadata**: "Used only to read message headers (sender, subject, thread and message IDs, dates) of new
inbox messages so the app can recognise replies and bounces to messages it sent and stop sending to bounced
addresses. The app never reads message bodies or attachments."

## Demo video (required)
Record an unlisted YouTube video showing, in English:
1. The consent screen with the app name and the **OAuth client ID visible in the browser URL**.
2. Granting access, landing back in the dashboard with the mailbox connected.
3. Each scope in use: sending a test email (gmail.send); a reply appearing as *Replied* (gmail.metadata).
4. Disconnecting the mailbox (access revoked).

## After approval
Switch the consent screen from *Testing* to *In production*. For `gmail.metadata`, schedule the yearly CASA
assessment (Google emails instructions after the scope review).
