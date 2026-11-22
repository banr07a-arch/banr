import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (Boolean(url) !== Boolean(key)) throw new Error("Set both Supabase environment variables.");
if (key && !key.startsWith("sb_publishable_")) throw new Error("Use a Supabase publishable key.");

const client = url ? createClient(url, key) : null;
export const live = Boolean(client);

async function data(request) {
  const result = await request;
  if (result.error) throw result.error;
  return result.data;
}

export const backend = {
  currentUser: async () => {
    const { session } = await data(client.auth.getSession());
    return session ? (await data(client.auth.getUser())).user : null;
  },
  authChanges: callback => client.auth.onAuthStateChange(callback),
  sendOtp: phone => data(client.auth.signInWithOtp({ phone })),
  verifyOtp: async (phone, token) => (await data(client.auth.verifyOtp({ phone, token, type: "sms" }))).user,
  signOut: () => data(client.auth.signOut()),
  facilities: () => data(client.from("facilities").select("*,doctors(*)").order("name")),
  sessions: doctorId => data(client.from("opd_sessions").select("*").eq("doctor_id", doctorId)
    .gt("ends_at", new Date().toISOString()).neq("status", "closed").order("starts_at")),
  profile: () => data(client.from("patient_profiles").select("name,age,sex").maybeSingle()),
  saveProfile: (userId, details) => data(client.from("patient_profiles").upsert({ ...details, user_id: userId })),
  appointments: () => data(client.rpc("banr_my_appointments")),
  book: (sessionId, { name, age, sex }) => data(client.rpc("banr_book_session", {
    p_session: sessionId, p_name: name, p_age: age, p_sex: sex,
  })),
};
