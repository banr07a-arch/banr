import { supportEmail, refundTerms, promotions, expertAnswers, helpFAQs, privacySections } from "./patient-content.js";

export const patientDefaults = {
  subtitle: "Save Your Time",
  supportEmail, refundTerms, promotions, expertAnswers, helpFAQs, privacySections,
  hero: null,
  about: [
    "BANR helps you find clinics and hospitals in your area, choose a doctor and book an available OPD visit.",
    "After booking, open Appointments to find your visit or My Token to see your token, the latest queue status and an estimated wait when available.",
  ],
};
export const providerDefaults = { subtitle: "Provider Portal", notice: "" };

const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");
const pairs = value => Array.isArray(value) && value.every(item => strings(item) && item.length === 2);
export function httpsUrl(value) {
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : ""; }
  catch { return ""; }
}
const banner = item => item && typeof item.title === "string" && typeof item.description === "string";
const expert = item => item && ["topic", "question", "answer"].every(key => typeof item[key] === "string");
const rules = {
  subtitle: value => typeof value === "string",
  notice: value => typeof value === "string",
  supportEmail: value => typeof value === "string" && (!value || /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)),
  hero: value => value === null || banner(value),
  promotions: value => Array.isArray(value) && value.every(banner),
  expertAnswers: value => Array.isArray(value) && value.every(expert),
  helpFAQs: pairs, privacySections: pairs, refundTerms: strings, about: strings,
};

export function contentWithDefaults(defaults, content, strict = false) {
  const result = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(content ?? {}, key)) continue;
    if (rules[key](content[key])) result[key] = content[key];
    else if (strict) throw new Error("Check the format for " + key + ".");
  }
  return result;
}
