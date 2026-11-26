import { createClient } from "npm:@supabase/supabase-js@2.119.2";

const env = (name: string) => Deno.env.get(name) || "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-onboarding-worker", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const base = () => new URL(env("BANR_ONBOARDING_PUBLIC_URL") || "https://banr-vert.vercel.app");
const path = (value: string) => new URL(value, base()).href;
const linkFor = (token: string) => path("/onboarding/") + "#" + token;
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}
const fill = (text: string, values: Record<string, unknown>) =>
  text.replace(/\{\{([a-z_]+)\}\}/g, (_, field) => String(values[field] ?? ""));

async function deliver(request?: string) {
  const messages = await rpc("banr_onboarding_claim_messages", { p_request: request ?? null });
  await Promise.all(messages.map(async (message: { id:string; channel:string; destination:string; attempt:number; subject:string; body:string; vars:Record<string,unknown> }) => {
    const sms = message.channel === "sms";
    const webhook = env(sms ? "BANR_ONBOARDING_SMS_WEBHOOK" : "BANR_ONBOARDING_EMAIL_WEBHOOK");
    const secret = env(sms ? "BANR_ONBOARDING_SMS_SECRET" : "BANR_ONBOARDING_EMAIL_SECRET");
    const to = message.channel === "team" ? env("BANR_ONBOARDING_TEAM_EMAIL") : message.destination;
    let error: string | null = null;
    try {
      if (!webhook.startsWith("https://") || !secret || !to) throw new Error("Delivery channel is not configured");
      const { token, ...variables } = message.vars;
      const values = { ...variables, portal: path("/provider/"), link: typeof token === "string" ? linkFor(token) : "" };
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret, "Idempotency-Key": message.id },
        body: JSON.stringify({ to, subject: fill(message.subject, values), text: fill(message.body, values) }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error("Delivery endpoint returned HTTP " + response.status);
    } catch (failure) { error = failure instanceof Error ? failure.message : "Delivery failed"; }
    await rpc("banr_onboarding_message_result", { p_id: message.id, p_attempt: message.attempt, p_ok: !error, p_error: error });
  }));
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
  try {
    if (Number(req.headers.get("content-length")) > 20000) return reply({ error: "Request too large." }, 413);
    const raw = await req.text();
    if (raw.length > 20000) return reply({ error: "Request too large." }, 413);
    const { action, ...data } = JSON.parse(raw);
    if (action === "submit") {
      const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env("SUPABASE_SERVICE_ROLE_KEY") + ":" + ip)));
      const client = Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
      const id = await rpc("banr_onboarding_submit", { p_data: data, p_client: client });
      if (!id) return reply({ error: "Too many requests. Try again in an hour." }, 429);
      if (id === "00000000-0000-0000-0000-000000000001") return reply({ error: "A pending request already exists for this phone or email." }, 409);
      await deliver(id);
      return reply({ id, sent: data.mode === "self" && await rpc("banr_onboarding_delivery", { p_request: id, p_template: "registration" }) });
    }
    if (action === "register") {
      if (typeof data.token !== "string" || !/^[a-f0-9]{64}$/.test(data.token) ||
          typeof data.password !== "string" || data.password.length < 12 || data.password.length > 72) {
        return reply({ error: "Use a valid registration link and a password of 12–72 characters." }, 400);
      }
      const invitation = await rpc("banr_onboarding_open", { p_token: data.token });
      if (!invitation) return reply({ error: "Registration link expired or already used." }, 400);
      const redirectTo = path("/onboarding/");
      const generated = await db.auth.admin.generateLink({ type: "signup", email: invitation.email, password: data.password, options: { redirectTo } });
      if (generated.error) return reply({ error: "Could not create the account. If you already have an account, sign in or use Send verification email." }, 400);
      const id = await rpc("banr_onboarding_verification", { p_token: data.token, p_link: generated.data.properties.action_link });
      if (!id) return reply({ error: "Registration link expired." }, 400);
      await deliver(id);
      return reply({ sent: await rpc("banr_onboarding_delivery", { p_request: id, p_template: "verification" }) });
    }
    if (action === "verify_again") {
      const invitation = await rpc("banr_onboarding_open", { p_token: data.token });
      if (!invitation) return reply({ error: "Registration link expired or already used." }, 400);
      const result = await rpc("banr_onboarding_resend_verification", { p_token: data.token });
      if (!result) return reply({ error: "Create the account first or wait before resending." }, 429);
      const generated = await db.auth.admin.generateLink({ type: "magiclink", email: invitation.email, options: { redirectTo: path("/onboarding/") } });
      if (generated.error) return reply({ error: "Could not create a new verification email." }, 400);
      const id = await rpc("banr_onboarding_verification", { p_token: data.token, p_link: generated.data.properties.action_link });
      await deliver(id);
      return reply({ sent: await rpc("banr_onboarding_delivery", { p_request: id, p_template: "verification" }) });
    }
    if (action === "drain") {
      const secret = env("BANR_ONBOARDING_WORKER_SECRET");
      if (!secret || req.headers.get("x-onboarding-worker") !== secret) return reply({ error: "Unauthorized." }, 401);
      await deliver();
      return reply({ ok: true });
    }
    if (["deliver", "document"].includes(action)) {
      const review = await rpc("banr_onboarding_admin", { p_token: data.session, p_action: "request", p_data: { id: data.id } });
      if (action === "deliver") { await deliver(data.id); return reply({ ok: true }); }
      if (typeof data.path !== "string" || !review.owner || !data.path.startsWith(review.owner + "/") ||
          ![...(review.profile?.photos || []), ...(review.profile?.documents || [])].includes(data.path)) return reply({ error: "File not found." }, 404);
      const { data: signed, error } = await db.storage.from("banr-provider-uploads").createSignedUrl(data.path, 60, { download: true });
      if (error) return reply({ error: "File unavailable." }, 404);
      return reply({ url: signed.signedUrl });
    }
    return reply({ error: "Unknown action." }, 400);
  } catch (error) {
    const message = (error as {message?:string})?.message;
    return reply({ error: message?.startsWith("A pending request") || message?.startsWith("Check the facility") ? message : "The request could not be completed. Try again." }, 400);
  }
});
