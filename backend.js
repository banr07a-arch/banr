import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (Boolean(url) !== Boolean(key)) throw new Error("Set both Supabase environment variables.");
if (key && !key.startsWith("sb_publishable_")) throw new Error("Use a Supabase publishable key.");

const client = url ? createClient(url, key) : null;
export const live = Boolean(client);
export const walkInSms = live && import.meta.env.VITE_WALK_IN_SMS_ENABLED === "true";

async function data(request) {
  const result = await request;
  if (result.error) throw result.error;
  return result.data;
}

export const backend = {
  content: p_key => data(client.rpc("banr_app_content", { p_key })),
  currentUser: async () => {
    const { session } = await data(client.auth.getSession());
    return session ? (await data(client.auth.getUser())).user : null;
  },
  authChanges: callback => client.auth.onAuthStateChange(callback),
  signIn: (email, password) => data(client.auth.signInWithPassword({ email, password })),
  signUp: (email, password) => data(client.auth.signUp({
    email, password, options: { emailRedirectTo: window.location.origin },
  })),
  sendWalkInCode: (phone, signedIn) => signedIn
    ? data(client.auth.updateUser({ phone }))
    : data(client.auth.signInWithOtp({ phone })),
  verifyWalkInCode: (phone, token, signedIn) => data(client.auth.verifyOtp({
    phone, token, type: signedIn ? "phone_change" : "sms",
  })),
  signOut: () => data(client.auth.signOut()),
  facilities: () => data(client.from("facilities").select("*,doctors(*)").order("name")),
  facilitySessions: (doctorIds, day) => doctorIds.length
    ? data(client.from("opd_sessions").select("doctor_id,starts_at,ends_at,status,booked_count,capacity")
      .in("doctor_id", doctorIds).gte("starts_at", day+"T00:00:00+05:30")
      .lt("starts_at", new Date(Date.parse(day+"T00:00:00+05:30")+86400000).toISOString())
      .order("starts_at"))
    : Promise.resolve([]),
  sessions: doctorId => data(client.from("opd_sessions").select("*").eq("doctor_id", doctorId)
    .gt("ends_at", new Date().toISOString()).neq("status", "closed").order("starts_at")),
  profile: () => data(client.from("patient_profiles").select("name,age,sex").maybeSingle()),
  saveProfile: (userId, details) => data(client.from("patient_profiles").upsert({ ...details, user_id: userId })),
  appointments: () => data(client.rpc("banr_my_appointments")),
  book: (sessionId, { name, age, sex }) => data(client.rpc("banr_book_session", {
    p_session: sessionId, p_name: name, p_age: age, p_sex: sex,
  })),
};
