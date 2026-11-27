# Provider onboarding operations

Apply `supabase/provider-onboarding.sql` after the provider, Super Admin, and Super Admin username migrations. Deploy `banr-onboarding` with its own authorization checks (public submission, secret-protected worker, and admin-session-protected review). Use the frontend paths `/onboarding/` and `/admin/onboarding.html`.

Set these Edge Function secrets:

| Secret | Purpose |
| --- | --- |
| BANR_ONBOARDING_PUBLIC_URL | Canonical app origin for registration and verification links |
| BANR_ONBOARDING_EMAIL_WEBHOOK | HTTPS adapter that accepts a JSON delivery request |
| BANR_ONBOARDING_EMAIL_SECRET | Bearer token for that adapter |
| BANR_ONBOARDING_SMS_WEBHOOK | HTTPS adapter for SMS |
| BANR_ONBOARDING_SMS_SECRET | Bearer token for that adapter |
| BANR_ONBOARDING_TEAM_EMAIL | Team inbox for assisted and self-registration leads |
| BANR_ONBOARDING_WORKER_SECRET | Random credential for the retry scheduler |

Both adapters accept `{to, subject, text}` and must deduplicate by the `Idempotency-Key` header. A 2xx response means the provider accepted the message. Schedule a call every five minutes to the Edge Function with `POST`, JSON `{"action":"drain"}` and the worker secret in the `x-onboarding-worker` header. Use a scheduler secret store. New submissions and approval actions also request immediate delivery. Failed messages retry up to five times and appear in the application message log.

Allow the exact `/onboarding/` URL under Supabase Auth Redirect URLs. Enable the Phone provider and configure Supabase Auth SMS delivery for OTP. Supabase Auth owns OTP expiry and verification rate limits. The request form sends its own registration and verification messages through the delivery adapters.

Use a private provider upload bucket and retain only the payout reference required by the payment provider. This workflow records plan selection and payout reference. It does not charge providers or issue payouts. After approval the clinic can schedule dated OPD sessions in the Provider Portal.
