import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

const screen = document.querySelector("#provider-screen");
const error = document.querySelector("#provider-error");
const notice = document.querySelector("#provider-status");
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const client = url && key ? createClient(url, key, { auth: { storageKey: "banr-provider-auth" } }) : null;

let facilities = [];
let doctors = [];
let sessions = [];
let facilityId = "";
let doctorId = "";
let sessionId = "";
let tab = "opd";
let busy = false;
let polling = false;

const labels = { scheduled: "Offline", late: "Doctor delayed", open: "Online", paused: "Paused", closed: "Closed" };
const escape = value => String(value ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const field = (label, name, value = "", options = "") =>
  `<label class="field">${label}<input name="${name}" value="${escape(value)}" ${options}></label>`;
const button = (label, action, disabled = false) =>
  `<button type="button" class="primary" data-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`;
const option = (value, label, selected) =>
  `<option value="${escape(value)}" ${value === selected ? "selected" : ""}>${escape(label)}</option>`;
const sessionDate = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
});
const clinicDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", dateStyle: "short" });
const localDateTime = value => value
  ? new Date(Date.parse(value) + 330 * 60000).toISOString().slice(0, 16) : "";
const ist = value => value ? value + ":00+05:30" : null;
const sessionLabel = session =>
  `${session.name} · ${sessionDate.format(new Date(session.starts_at))} · ${labels[session.status] ?? session.status}`;

async function read(request) {
  const { data, error: failure } = await request;
  if (failure) throw failure;
  return data;
}

async function run(work) {
  if (busy) return;
  busy = true;
  error.textContent = "";
  notice.textContent = "";
  try {
    await work();
  } catch (failure) {
    error.textContent = failure.message || "Could not complete this action. Try again.";
  } finally {
    busy = false;
  }
}

function login() {
  screen.innerHTML = '<h1 class="pagehead">Staff Sign In</h1><form class="panel raised stack" data-form="login">' +
    field("Staff email", "email", "", 'type="email" autocomplete="username" required') +
    field("Password", "password", "", 'type="password" autocomplete="current-password" required') +
    '<button class="primary">Sign In</button></form>';
}

async function loadAccount() {
  facilities = await read(client.rpc("banr_provider_facilities"));
  if (!facilities.length) {
    screen.innerHTML = '<h1 class="pagehead">Facility access required</h1><p class="panel raised">This account has no assigned facility.</p>' +
      button("Sign Out", "signout");
    return;
  }
  if (!facilities.some(item => item.id === facilityId)) facilityId = facilities[0].id;
  await loadDoctors();
  render();
}

async function loadDoctors() {
  doctors = await read(client.from("doctors").select("id,name,specialty,fee,consultation_minutes")
    .eq("facility_id", facilityId).order("name"));
  if (!doctors.some(item => item.id === doctorId)) doctorId = doctors[0]?.id ?? "";
  await loadSessions();
}

async function loadSessions() {
  sessions = doctorId ? await read(client.from("opd_sessions").select("*").eq("doctor_id", doctorId)
    .gt("ends_at", new Date(Date.now() - 86400000).toISOString()).order("starts_at")) : [];
  if (!sessions.some(item => item.id === sessionId)) {
    const now = new Date();
    const today = sessions.filter(item => clinicDay.format(new Date(item.starts_at)) === clinicDay.format(now));
    sessionId = (today.find(item => item.status === "open" || item.status === "paused") ??
      today.find(item => item.status !== "closed" && Date.parse(item.ends_at) > now.getTime()) ??
      today.at(-1) ?? sessions.find(item => Date.parse(item.starts_at) > now.getTime()))?.id ?? "";
  }
}

const singleDoctor = () => doctors.length <= 1 &&
  String(facilities.find(item => item.id === facilityId)?.type ?? "").toLowerCase() !== "hospital";

function settings() {
  const facility = facilities.find(item => item.id === facilityId);
  const doctor = doctors.find(item => item.id === doctorId);
  const session = sessions.find(item => item.id === sessionId);
  const scheduleFields = (item = {}) =>
    `<label class="field">OPD session<select name="name">${["Morning", "Evening"].map(value =>
      option(value, value, item.name)).join("")}</select></label>` +
    field("Starts (IST)", "starts_at", localDateTime(item.starts_at), 'type="datetime-local" required') +
    field("Ends (IST)", "ends_at", localDateTime(item.ends_at), 'type="datetime-local" required') +
    field("Appointment limit", "capacity", item.capacity ?? 18, 'type="number" min="1" required');
  return '<h1 class="pagehead">Facility Settings</h1><form class="panel raised stack" data-form="facility"><h2>Facility Profile</h2>' +
    field("Facility name", "name", facility.name, "required") + field("Locality", "area", facility.area, "required") +
    field("Address", "address", facility.address, "required") + field("Opening hours", "hours", facility.hours, "required") +
    field("Public contact", "contact", facility.contact) + '<button class="primary">Save Profile</button></form>' +
    (singleDoctor() && doctor ? '' : '<form class="panel raised stack" data-form="doctor"><h2>Add Doctor</h2>' + doctorFields() +
    '<button class="primary">Add Doctor</button></form>') +
    (doctor ? '<form class="panel raised stack" data-form="doctor"><h2>Edit Selected Doctor</h2>' +
      `<input type="hidden" name="doctor_id" value="${escape(doctor.id)}">` + doctorFields(doctor) +
      '<button class="primary">Save Doctor</button></form>' + button("Delete Selected Doctor", "delete-doctor") +
      '<form class="panel raised stack" data-form="session">' +
      '<h2>Add OPD Session</h2>' + scheduleFields() + '<button class="primary">Add Session</button></form>' : '') +
    (session && ["scheduled", "late"].includes(session.status) && !session.booked_count && Date.parse(session.starts_at) > Date.now()
      ? '<form class="panel raised stack" data-form="session"><h2>Edit Selected OPD</h2>' +
        `<input type="hidden" name="session_id" value="${escape(session.id)}">` + scheduleFields(session) +
        '<button class="primary">Save Session</button></form>' : '') +
    '<section class="panel raised stack"><h2>Facility QR</h2><canvas id="facility-qr" aria-label="Facility QR code"></canvas>' +
    '<a id="facility-link">Open patient link</a><a id="download-qr" download="banr-facility-qr.png">Download QR</a></section>';
}

function doctorFields(doctor = {}) {
  return field("Doctor name", "name", doctor.name, "required") +
    field("Specialty", "specialty", doctor.specialty, "required") +
    field("Consultation fee (₹)", "fee", doctor.fee, 'type="number" min="0" required') +
    field("Average consultation (minutes)", "consultation_minutes", doctor.consultation_minutes ?? 10,
      'type="number" min="1" max="180" required');
}

function liveOpd() {
  if (!sessionId) return '<h1 class="pagehead">Today’s OPD</h1><p class="panel raised">Select or add a doctor and session in Facility Settings.</p>';
  return '<h1 class="pagehead">Today’s OPD</h1><section class="panel raised stack" id="provider-queue" aria-live="polite">Loading queue…</section>' +
    '<form class="panel raised stack" data-form="late" id="provider-late"><h2>Doctor Delay</h2>' +
    `<label class="field">Delay from now<select name="delay_minutes" required><option value="">Choose minutes</option>${
      [5, 10, 15, 20, 25, 30].map(minutes => option(String(minutes), `${minutes} min`)).join("")
    }</select></label>` +
    '<button class="primary">Update Start Time</button></form>' +
    '<form class="panel raised stack" data-form="walkin" id="provider-walkin"><h2>Add Walk-in</h2>' +
    field("Patient name", "name", "", "required maxlength=80") + field("Mobile number", "mobile", "", 'type="tel" required') +
    '<label class="field">Sex<select name="sex" required><option value="">Select</option><option>Female</option><option>Male</option>' +
    '<option>Intersex</option><option>Prefer not to say</option></select></label>' +
    field("Age", "age", "", 'type="number" min="0" max="120" required') +
    '<button class="primary">Add Walk-in</button></form>';
}

let queue = null;
let queueRevision = 0;
function showQueue(next) {
  const panel = screen.querySelector("#provider-queue");
  if (!panel) return;
  queue = next;
  const started = next.status === "open";
  const preStart = ["scheduled", "late"].includes(next.status);
  const lock = Math.max(0, Math.ceil((Date.parse(next.advance_after ?? "") - Date.now()) / 1000)) || 0;
  const actions = (preStart ? button("Go Online", "start") : "") +
    (started ? '<div class="queue-advance">' +
      button(lock ? `Next (${lock}s)` : "Next", "next", lock > 0 || (!next.serving && !next.waiting)) +
      button("No Show", "no_show", lock > 0 || !next.serving) +
      '</div>' + button("Pause", "pause") : "") +
    (next.status === "paused" ? button("Resume", "resume") : "") +
    (next.status === "closed" ? "" : button("Close OPD", "close"));
  const html = `<h2>${escape(labels[next.status] ?? next.status)}</h2><div class="numbers">
    <div class="stat"><p>Current token</p><div class="number">${next.serving ? next.current_token : "—"}</div></div>
    <div class="stat"><p>Waiting</p><div class="number">${next.waiting}</div></div></div>
    <p>${next.booked_count} of ${next.capacity} appointments booked</p>` +
    (next.revised_start_at ? `<p>Revised start: ${sessionDate.format(new Date(next.revised_start_at))}</p>` : "") +
    '<div class="queue-actions">' + actions + '</div>';
  if (panel.innerHTML !== html) panel.innerHTML = html;
  screen.querySelector("#provider-late").hidden = !preStart;
  screen.querySelector("#provider-walkin").hidden = next.status === "closed";
}

async function refreshQueue() {
  if (tab !== "opd" || !sessionId || polling) return;
  const session = sessionId;
  const revision = queueRevision;
  polling = true;
  try {
    const next = await read(client.rpc("banr_provider_queue", { p_session: session }));
    if (tab === "opd" && sessionId === session && queueRevision === revision) showQueue(next);
  } finally {
    polling = false;
  }
}

function render() {
  queueRevision++;
  queue = null;
  screen.innerHTML = '<div class="chips">' + button("Facility Settings", "settings") + button("Live OPD", "opd") +
    button("Sign Out", "signout") + '</div><section class="panel raised stack">' +
    `<label class="field">Facility<select id="provider-facility">${facilities.map(item => option(item.id,item.name,facilityId)).join("")}</select></label>
    ${singleDoctor() ? `<p class="doctor-name">${escape(doctors[0]?.name ?? "")}</p>` : `<label class="field">Doctor<select id="provider-doctor">${doctors.map(item => option(item.id,item.name,doctorId)).join("")}</select></label>`}
    <label class="field">Session<select id="provider-session">${sessions.map(item => option(item.id,sessionLabel(item),sessionId)).join("")}</select></label></section>` +
    (tab === "settings" ? settings() : liveOpd());
  if (tab === "opd") {
    void refreshQueue().catch(failure => { error.textContent = failure.message; });
  } else {
    const link = new URL("/", location.origin);
    link.searchParams.set("facility", facilityId);
    screen.querySelector("#facility-link").href = link.href;
    const canvas = screen.querySelector("#facility-qr");
    const download = screen.querySelector("#download-qr");
    QRCode.toCanvas(canvas, link.href, { width: 190 }).then(() => {
      download.href = canvas.toDataURL();
    }).catch(() => { error.textContent = "Could not generate the facility QR."; });
  }
}

async function queueAction(action, data = {}) {
  if (!queue || !sessionId) throw new Error("Wait for the selected queue to load.");
  queueRevision++;
  const next = await read(client.rpc("banr_provider_action", {
    p_session: sessionId, p_action: action, p_expected_token: queue.current_token, p_data: data,
  }));
  showQueue(next);
  if (next.walkin) {
    notice.textContent = `Token #${next.walkin.token} · ` + (next.walkin.wait_minutes == null
      ? "Wait estimate unavailable" : `Estimated wait ${next.walkin.wait_minutes} min`);
  }
}

screen.addEventListener("change", event => {
  const { id, value } = event.target;
  if (!["provider-facility", "provider-doctor", "provider-session"].includes(id)) return;
  void run(async () => {
    if (id === "provider-facility") {
      facilityId = value;
      doctorId = sessionId = "";
      await loadDoctors();
    } else if (id === "provider-doctor") {
      doctorId = value;
      sessionId = "";
      await loadSessions();
    } else {
      sessionId = value;
    }
    render();
  });
});

screen.addEventListener("click", event => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  void run(async () => {
    if (action === "signout") {
      await read(client.auth.signOut({ scope: "local" }));
      facilities = [];
      facilityId = doctorId = sessionId = "";
      tab = "opd";
      login();
    } else if (action === "settings" || action === "opd") {
      tab = action;
      await loadSessions();
      render();
    } else if (action === "delete-doctor") {
      const doctor = doctors.find(item => item.id === doctorId);
      if (!doctor || !confirm(`Delete ${doctor.name}? Doctors with OPD sessions cannot be deleted.`)) return;
      await read(client.rpc("banr_provider_delete_doctor", { p_facility: facilityId, p_doctor: doctor.id }));
      await loadAccount();
      notice.textContent = "Doctor deleted.";
    } else if (action === "close") {
      if (!queue) return;
      const pending = queue.waiting + Number(queue.serving);
      if (!confirm(pending ? `Close OPD with ${pending} pending patient(s)?` : "Close this OPD session?")) return;
      await queueAction(action, { pending_count: pending });
    } else {
      await queueAction(action);
    }
  });
});

screen.addEventListener("submit", event => {
  const form = event.target;
  event.preventDefault();
  void run(async () => {
    const type = form.dataset.form;
    const data = Object.fromEntries(new FormData(form));
    if (type === "login") {
      await read(client.auth.signInWithPassword({ email: data.email.trim(), password: data.password }));
      await loadAccount();
    } else if (type === "walkin" || type === "late") {
      await queueAction(type, data);
      form.reset();
    } else {
      if (type === "session") {
        data.doctor_id = doctorId;
        data.starts_at = ist(data.starts_at);
        data.ends_at = ist(data.ends_at);
      }
      await read(client.rpc("banr_provider_manage", { p_facility: facilityId, p_action: type, p_data: data }));
      await loadAccount();
      notice.textContent = "Saved.";
    }
  });
});

if (!client) {
  error.textContent = "Connect BANR’s Supabase project to use the provider portal.";
} else {
  void run(async () => {
    const { session } = await read(client.auth.getSession());
    if (session) await loadAccount();
    else login();
  });
  setInterval(() => {
    if (!busy && tab === "opd" && queue?.advance_after && screen.querySelector("[data-action=next]")) showQueue(queue);
  }, 250);
  setInterval(() => {
    if (!busy && tab === "opd" && sessionId) void refreshQueue().catch(() => {
      error.textContent = "Could not refresh the queue. Showing the last update.";
    });
  }, 5000);
}
