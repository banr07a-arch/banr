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

A facility QR can point to `/?facility=<facility-id>`. Walk-in lookup requires a verified mobile number. Email sign-in supports online bookings and their tokens. The patient app reads queue state every five seconds on the tracking screen. A staff workflow must eventually supply walk-in records and queue changes.
