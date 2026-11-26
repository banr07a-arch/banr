# BANR

Patient web app for clinic discovery, OPD booking, email sign-in and live tokens.

## Run locally

Use Node.js 22.12+ and run `npm ci` followed by `npm run dev`. Without Supabase configuration the app runs in a labeled demo mode. Demo OTP is 123456. Use sample patient details.

## Connect the new BANR Supabase project

1. Run `supabase/patient.sql` once in the SQL Editor of a new BANR project. Leave `banr_private` outside the Data API's exposed schemas.
2. Enable Email in Supabase Auth and configure the production Site URL and allowed redirect URLs. For databases initialized before email sign-in, run `supabase/email-auth.sql`.
3. Copy `.env.example` to `.env.local` and set the project URL and publishable key. The app runs in live mode when both are set.
4. Add the actual facilities, doctors and OPD sessions to the new database. Facility location selection filters the catalog by area or address.
5. Run `npm run build` for the Vercel deployment. Set the same public environment variables in Vercel and use `dist` as the output directory.

A facility QR can point to `/?facility=<facility-id>`. Walk-in lookup requires a verified mobile number. Email sign-in supports online bookings and their tokens. The patient app reads queue state every five seconds on the tracking screen. Staff register walk-ins and update the queue in the provider portal.

For live QR walk-in tracking, configure the Phone provider and SMS delivery in Supabase Auth, then set `VITE_WALK_IN_SMS_ENABLED=true` for the patient build. Signed-in patients verify their number on the existing account. Signed-out patients use SMS sign-in. Enable the flag only after the SMS service is configured.

## Patient content

Edit `patient-content.js` to update BANR support email, approved refund terms and Home promotions. Set `sponsored: true` on paid slides. For Expert Q&A, add `topic`, `question`, `answer` and a `review` record with `status: "reviewed"`, `verified: true`, `name`, `credential` and `date` only after verifying the healthcare professional and receiving approval. Keep unapproved answers outside the frontend source because source content is public.

## Provider portal

The staff portal uses `/provider/` and the same project URL and publishable key as the patient app. Apply `supabase/provider.sql` after the patient schema is installed. Create or invite each staff account in Supabase Auth, then assign the confirmed Auth user ID and facility ID in `banr_private.provider_staff` using the SQL Editor. Staff assignments are managed by the database owner. Use a dedicated staff account and keep `banr_private` outside the Data API's exposed schemas.

OPD times are entered in India Standard Time. A new session copies its doctor's consultation duration, and an upcoming unbooked session can be edited. Walk-ins and online bookings share the same session limit and token sequence. The facility QR opens the patient facility entry point, including the doctor list and the existing verified-mobile walk-in lookup.
