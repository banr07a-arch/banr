import { currentSection, showAdminSection, hideAdminNavigation } from "./admin-layout.js";
import { createClient } from "@supabase/supabase-js";
import { patientDefaults, providerDefaults, contentWithDefaults, httpsUrl } from "../managed-content.js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const client = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) : null;
const sessionKey = "banr-admin-session";
let token = sessionStorage.getItem(sessionKey) || "";
const screen = document.querySelector("#screen");
const error = document.querySelector("#error");
const status = document.querySelector("#status");
const signOut = document.querySelector("#sign-out");
const defaults = { patient: patientDefaults, provider: providerDefaults };
const escape = value => String(value ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const button = (label, type = "button") => `<button class="primary" type="${type}">${label}</button>`;
const input = (label, key, value = "", type = "text") =>
  `<label class="field">${label}<input name="${key}" value="${escape(value)}" type="${type}"></label>`;
const area = (label, key, value = "") =>
  `<label class="field">${label}<textarea name="${key}">${escape(value)}</textarea></label>`;

const groups = {
  hero: ["Main banner", "banner"], promotions: ["Extra banners and ads", "banner"],
  helpFAQs: ["Help Center", "pair"], privacySections: ["Privacy Policy", "pair"],
  refundTerms: ["Refund Policy", "text"], about: ["About BANR", "text"],
  expertAnswers: ["Expert Q&A", "expert"],
};
function item(kind, value) {
  let fields;
  if (kind === "banner") {
    fields = input("Title", "title", value?.title) + area("Description", "description", value?.description) +
      input("Image URL (HTTPS)", "imageUrl", value?.imageUrl, "url") + input("Button link (HTTPS)", "link", value?.link, "url") +
      '<label><input name="sponsored" type="checkbox"' + (value?.sponsored === true ? " checked" : "") + '> Sponsored ad</label>';
  } else if (kind === "pair") {
    fields = input("Heading or question", "heading", value?.[0]) + area("Text", "body", value?.[1]);
  } else if (kind === "expert") {
    fields = input("Topic", "topic", value?.topic) + input("Question", "question", value?.question) +
      area("Answer", "answer", value?.answer) + input("Reviewer name", "reviewer", value?.review?.name) +
      input("Reviewer credential", "credential", value?.review?.credential) + input("Review date", "reviewDate", value?.review?.date, "date") +
      '<label><input name="approved" type="checkbox"' + (value?.review?.status === "reviewed" && value?.review?.verified === true ? " checked" : "") +
      '> Publish after verifying the reviewer and getting approval</label>';
  } else fields = area("Text", "body", value);
  return `<fieldset class="stack"><legend>Entry</legend>${fields}
    <div><button type="button" data-move="-1">Move up</button> <button type="button" data-move="1">Move down</button>
    <button type="button" data-remove>Remove</button></div></fieldset>`;
}

function group(key, value) {
  const [label, kind] = groups[key];
  const entries = key === "hero" ? (value ? [value] : []) : value;
  return `<details class="raised" data-group="${key}"><summary>${label}</summary>
    <div class="stack items">${entries.map(entry => item(kind, entry)).join("")}</div>
    <button type="button" data-add>${key === "hero" ? "Add custom main banner" : "Add entry"}</button></details>`;
}

function readItem(kind, entry) {
  const get = name => entry.querySelector('[name="' + name + '"]');
  const value = name => get(name).value.trim();
  if (kind === "banner") {
    const imageUrl = value("imageUrl"), link = value("link");
    if ((imageUrl && !httpsUrl(imageUrl)) || (link && !httpsUrl(link))) throw new Error("Banner links must use HTTPS.");
    const title = value("title");
    if (!title) throw new Error("Enter a title for each banner.");
    return { title, description: value("description"), imageUrl, link, sponsored: get("sponsored").checked };
  }
  if (kind === "pair") return [value("heading"), value("body")];
  if (kind === "expert") {
    const answer = { topic: value("topic"), question: value("question"), answer: value("answer") };
    if (get("approved").checked) {
      const name = value("reviewer"), credential = value("credential"), date = value("reviewDate");
      if (![answer.topic, answer.question, answer.answer, name, credential, date].every(Boolean)) {
        throw new Error("Complete the answer and reviewer details before publishing.");
      }
      answer.review = { status: "reviewed", verified: true, name, credential, date };
    }
    return answer;
  }
  return value("body");
}

async function data(request) {
  const result = await request;
  if (result.error) throw result.error;
  return result.data;
}
const admin = (p_action, p_data = {}) => data(client.rpc("banr_admin_session", { p_token: token, p_action, p_data }));

function login(setup = false) {
  hideAdminNavigation();
  signOut.hidden = true;
  screen.innerHTML = '<form class="panel raised stack" data-form="login"><h2>' + (setup ? 'Set Super Admin Password' : 'Super Admin Sign In') + '</h2>' +
    '<label class="field">Username<input name="username" autocomplete="username" required minlength="3" maxlength="32" autocapitalize="none" spellcheck="false"></label>' +
    '<label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>' +
    (setup ? '<label class="field">Setup code<input name="setup" autocomplete="off" required></label><p>Use a password with at least 12 characters.</p>' : '') +
    button(setup ? "Set Password" : "Sign In", "submit") +
    (setup ? '<button type="button" data-login-mode>Back to sign in</button>' :
      '<button type="button" data-login-mode="setup">First-time setup</button>') + '</form>';
}

async function dashboard() {
  const settings = await admin("load");
  const content = await Promise.all(Object.keys(defaults).map(async key =>
    contentWithDefaults(defaults[key], await admin("content", { key }))));
  const [patient, provider] = content;
  screen.innerHTML = '<form class="panel raised stack" data-form="patient"><h2>Patient App</h2>' +
    '<div class="admin-grid">' + input("Header subtitle", "subtitle", patient.subtitle) +
    input("Support email", "supportEmail", patient.supportEmail, "email") + '</div>' +
    '<div class="admin-grid">' + Object.keys(groups).map(key => group(key, patient[key])).join("") + '</div>' +
    '<p>Only published Expert Q&A entries are sent to the public app. Keep drafts out of this form.</p>' +
    button("Publish Patient Content", "submit") + '</form>' +
    '<form class="panel raised stack" data-form="provider"><h2>Provider Portal</h2>' +
    input("Header subtitle", "subtitle", provider.subtitle) + area("Notice for signed-in staff", "notice", provider.notice) +
    button("Publish Provider Content", "submit") + '<a href="../provider/">Open Provider Portal</a></form>' +
    '<form class="panel raised stack" data-form="staff"><h2>Clinic Staff Access</h2>' +
    '<p>Create and confirm the staff login in Supabase, then assign a clinic here.</p>' +
    input("Staff email", "email", "", "email") +
    '<label class="field">Clinic or hospital<select name="facility" required><option value="">Choose a facility</option>' +
    settings.facilities.map(f => `<option value="${escape(f.id)}">${escape(f.name)}</option>`).join("") + '</select></label>' +
    '<div><button class="primary" value="grant_staff">Grant Access</button> <button value="revoke_staff">Remove Access</button></div>' +
    '<div data-staff-list class="stack"></div></form>';
  showStaff(settings.staff);
  signOut.hidden = false;
  syncSection();
}
function syncSection() {
  if (!screen.querySelector('[data-form="patient"]')) return;
  const selected = currentSection(["patient", "provider", "staff"], "patient");
  showAdminSection(selected);
  for (const form of screen.querySelectorAll("form[data-form]")) form.hidden = form.dataset.form !== selected;
}
window.addEventListener("hashchange", () => {
  syncSection();
  document.querySelector("#page-title").focus();
});

function showStaff(staff) {
  screen.querySelector("[data-staff-list]").innerHTML = staff.length
    ? '<h3>Current staff assignments</h3><ul>' +
      staff.map(row => `<li>${escape(row.email)} · ${escape(row.facility)}</li>`).join("") + '</ul>'
    : '<p>No clinic staff assigned.</p>';
}
let busy = false;
async function run(action) {
  if (busy) return;
  busy = true;
  error.textContent = status.textContent = "";
  try { await action(); }
  catch (failure) { error.textContent = failure.message || "Action failed."; }
  finally { busy = false; }
}

screen.addEventListener("click", event => {
  const mode = event.target.closest("[data-login-mode]");
  if (mode) { error.textContent = ""; login(mode.dataset.loginMode === "setup"); return; }
  const target = event.target.closest("[data-add],[data-remove],[data-move]");
  if (!target) return;
  if (target.hasAttribute("data-add")) {
    const group = target.closest("[data-group]");
    const entries = group.querySelector(".items");
    if (group.dataset.group === "hero" && entries.childElementCount) return;
    entries.insertAdjacentHTML("beforeend", item(groups[group.dataset.group][1]));
  } else {
    const entry = target.closest("fieldset");
    if (target.hasAttribute("data-remove")) entry.remove();
    else if (target.dataset.move === "-1" && entry.previousElementSibling) entry.before(entry.previousElementSibling);
    else if (target.dataset.move === "1" && entry.nextElementSibling) entry.after(entry.nextElementSibling);
  }
});

screen.addEventListener("submit", event => {
  event.preventDefault();
  void run(async () => {
    const form = event.target;
    const key = form.dataset.form;
    const raw = Object.fromEntries(new FormData(form));
    if (key === "login") {
      const username = raw.username.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username)) throw new Error("Enter a valid username.");
      const length = new TextEncoder().encode(raw.password).length;
      if (length < 12 || length > 72) throw new Error("Use a password between 12 and 72 bytes.");
      token = await data(client.rpc("banr_admin_credentials", {
        p_username: username, p_password: raw.password, p_setup: raw.setup?.trim() || null,
      }));
      if (!token) throw new Error("Sign-in failed. Check your details and try again later.");
      sessionStorage.setItem(sessionKey, token);
      screen.replaceChildren();
      await dashboard();
      return;
    }
    if (key === "staff") {
      if (!raw.email.trim()) throw new Error("Enter the staff email address.");
      const action = event.submitter?.value;
      if (!["grant_staff", "revoke_staff"].includes(action)) return;
      await admin(action, raw);
      showStaff((await admin("load")).staff);
      status.textContent = action === "grant_staff" ? "Clinic access granted." : "Clinic access removed.";
      return;
    }
    const payload = { subtitle: raw.subtitle.trim() };
    if (key === "provider") payload.notice = raw.notice.trim();
    else {
      payload.supportEmail = raw.supportEmail.trim();
      for (const [name, [, kind]] of Object.entries(groups)) {
        const entries = Array.from(form.querySelectorAll('[data-group="' + name + '"] fieldset'),
          entry => readItem(kind, entry));
        payload[name] = name === "hero" ? (entries[0] ?? null) : name === "expertAnswers"
          ? entries.filter(entry => entry.review?.verified) : entries;
      }
    }
    await admin("save_content", { key, value: contentWithDefaults(defaults[key], payload, true) });
    status.textContent = "Published. Changes appear when the app is reopened.";
  });
});

signOut.addEventListener("click", () => void run(async () => {
  try { await admin("signout"); }
  finally { token = ""; sessionStorage.removeItem(sessionKey); login(); }
}));

if (!client) error.textContent = "Connect BANR to Supabase to use Super Admin.";
else void run(async () => {
  if (!token) { login(); return; }
  try { await dashboard(); }
  catch (failure) {
    if (failure.code !== "42501") throw failure;
    token = "";
    sessionStorage.removeItem(sessionKey);
    login();
  }
});
