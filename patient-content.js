// Publish only contact information and policy text approved by BANR.
export const supportEmail = "";
export const refundTerms = [];

export const promotions = [
  { title: "Find an OPD near you", description: "Browse nearby clinics and hospitals.", sponsored: false },
  { title: "Keep track of your token", description: "Check your turn and estimated wait in My Token.", sponsored: false },
];

// The publishing maintainer must verify the reviewer’s professional credentials
// and record their approval before marking an answer as reviewed.
export const expertAnswers = [];

export const helpFAQs = [
  ["How do I book an appointment?", "Open Home, choose a clinic or hospital and a doctor, then select an available OPD session. Sign in if prompted and complete the booking. Find your confirmed visit under Appointments."],
  ["How do I sign in?", "Open Account and choose Email Login. Use your registered email and password, or create an account and follow the email confirmation instructions before signing in."],
  ["How do I track my token?", "Open My Token, or select Track Token on your appointment. You can see your token, the current token when the OPD is serving patients, and an estimated wait when available."],
  ["What if the OPD is delayed?", "Check My Token for the latest OPD status and any revised start time. Ask the clinic or hospital reception if you need an update before travelling."],
  ["What if I miss my turn?", "Ask the clinic or hospital reception whether your token can still be served or whether you need a new booking."],
];

export const privacySections = [
  ["What BANR uses", "BANR uses your email for account sign-in. Your patient profile includes your name, age and sex. Booking records link your account to an OPD session, appointment status and token. Where a walk-in record exists, a verified mobile number can be used to find the matching record."],
  ["How it is used", "BANR uses this information to manage your profile, create and display your bookings, and show OPD queue and token updates. The location you choose helps filter clinics and hospitals."],
  ["Where information is handled", "Supabase provides authentication and database services. Vercel hosts the app. Your browser stores the selected location locally. Demo mode also stores sample sign-in, profile and booking data in the browser."],
  ["Access to bookings", "BANR's patient booking view uses your signed-in account. A walk-in record is matched using a verified mobile number. Clinic, hospital, doctor and OPD listings can be browsed without signing in."],
];
