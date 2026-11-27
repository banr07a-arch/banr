import { createClient } from "@supabase/supabase-js";
const url=import.meta.env.VITE_SUPABASE_URL, key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export function connection(options={}) {
  if (!url || !key) throw new Error("This preview is not connected to BANR.");
  return createClient(url,key,options);
}
export const screen = document.querySelector("#screen");
export const err = document.querySelector("#error");
export const status = document.querySelector("#status");
export const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[char]);
export const input=(label,name,value="",attributes="")=>`<label class="field">${label}<input name="${name}" value="${escape(value)}" ${attributes}></label>`;
export const area=(label,name,value="",attributes="")=>`<label class="field">${label}<textarea name="${name}" ${attributes}>${escape(value)}</textarea></label>`;
export const button=(label,attributes='type="button"')=>`<button class="primary" ${attributes}>${label}</button>`;
export const option=(value,label,selected)=>`<option value="${escape(value)}"${value===selected?" selected":""}>${escape(label)}</option>`;
export async function data(promise) {
  const result=await promise;
  if (result.error) throw result.error;
  return result.data;
}
export async function edge(client,body) {
  const response=await client.functions.invoke("banr-onboarding",{body});
  if (!response.error) return response.data;
  let details;
  try { details=await response.error.context?.json(); } catch {}
  throw new Error(details?.error || "Could not reach BANR. Try again.");
}
export function planCards(plans) {
  if (!plans.length) return "<p>No subscription plans are currently available.</p>";
  return '<div class="plans">'+plans.map(p=>`<article><h3>${escape(p.name)}</h3>
    <p>${escape(p.currency)} ${escape(p.price)} / ${escape(p.cycle)}</p>
    <ul>${p.features.map(f=>`<li>${escape(f)}</li>`).join("")}</ul>
    <p>${Object.entries(p.limits).map(([k,v])=>escape(k)+": "+escape(v)).join(" · ")}</p></article>`).join("")+"</div>";
}
