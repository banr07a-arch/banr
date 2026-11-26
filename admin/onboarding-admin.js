import { connection, screen, err, status, escape, input, area, button, option, data, edge } from "../onboarding/common.js";

let client;
const session=()=>sessionStorage.getItem("banr-admin-session");
const admin=(p_action,p_data={})=>data(client.rpc("banr_onboarding_admin",{p_token:session(),p_action,p_data}));
const stages=["Requested","Link Sent","Link Opened","Registered","Email Verified","Profile Completed","Pending Approval","Approved","Rejected"];
const date=value=>value?new Date(value).toLocaleString():"";
let query={search:"",status:"",mode:"",offset:0}, section="requests";
const panel=body=>'<section class="panel raised stack">'+body+'</section>';
const action=(label,name,id)=>button(label,'type="button" data-action="'+name+'" data-id="'+escape(id)+'"');
function requestCard(r) {
  return '<article class="panel raised stack'+(r.stuck?' stuck':'')+'"><h3>'+escape(r.facility_name)+'</h3>'+
    '<p>'+escape(r.contact_name)+' · '+escape(r.phone)+' · '+escape(r.email)+'</p>'+
    '<p>'+escape(r.mode==='self'?'Self Registration':'Assisted Onboarding')+' · '+escape(date(r.created_at))+'</p>'+
    '<p><strong>'+escape(r.status)+'</strong>'+ (r.stuck?' · Waiting over 48 hours':'')+'</p>'+
    (r.contacted_at?'<p>Contacted '+escape(date(r.contacted_at))+'</p>':'')+
    '<div class="actions">'+action("Review","review",r.id)+action("Mark contacted","contact",r.id)+
    (["Requested","Link Sent","Link Opened"].includes(r.status)?
     (r.mode==="self"?action("Resend link","resend",r.id):action("Start registration","convert",r.id)):"")+
    '</div><details><summary>Follow-up notes</summary><ul>'+r.notes.map(n=>'<li>'+escape(n.text)+' · '+escape(date(n.at))+'</li>').join("")+
    '</ul><form data-form="note" data-id="'+escape(r.id)+'" class="stack">'+area("Add note","note","","required maxlength=3000")+
    button("Save Note",'type="submit"')+'</form></details><div data-review="'+escape(r.id)+'"></div></article>';
}
function planCard(plan={details:{},active:true}) {
  const p=plan.details;
  return '<form data-form="plan" data-id="'+escape(plan.id??"")+'" class="panel raised stack"><h3>'+
    escape(p.name||"Add subscription plan")+'</h3><div class="split">'+input("Name","name",p.name,"required")+
    input("Price","price",p.price,"required type=number step=any")+
    input("Currency","currency",p.currency??"INR","required")+input("Billing cycle","cycle",p.cycle??"monthly","required")+'</div>'+
    area("Features, one per line","features",p.features?.join("\n"))+
    area("Limits, one per line (name=value)","limits",Object.entries(p.limits??{}).map(([k,v])=>k+"="+v).join("\n"))+
    '<label class="field">Visibility<select name="active">'+option("true","Active",String(plan.active))+option("false","Inactive",String(plan.active))+'</select></label>'+
    '<div class="actions">'+button(plan.id?"Save Plan":"Add Plan",'type="submit"')+
    (plan.id?action("Delete Plan","delete-plan",plan.id):"")+'</div></form>';
}
function templateCard(t) {
  return '<form data-form="template" data-id="'+escape(t.key)+'" class="panel raised stack"><h3>'+escape(t.key)+'</h3>'+
    input("Email subject","subject",t.subject,"required maxlength=200")+
    area("Message text","body",t.body,"required maxlength=10000")+button("Save Template",'type="submit"')+'</form>';
}
function navigation() {
  return '<div class="actions">'+[["requests","Provider Requests"],["plans","Subscription Plans"],["templates","Notification Templates"]]
    .map(([key,label])=>button(label,'type="button" data-section="'+key+'" aria-pressed="'+(section===key)+'"')).join("")+'</div>';
}
async function draw() {
  const result=await admin("dashboard",query);
  let body;
  if (section==="plans") body=planCard()+result.plans.map(planCard).join("");
  else if (section==="templates") body=panel('<p>Available placeholders: {{contact}}, {{facility}}, {{mode}}, {{link}}, {{verification_link}}, {{portal}}, {{reason}}.</p>')+
    result.templates.map(templateCard).join("");
  else body='<form data-form="filters" class="panel raised stack"><h2>Provider Requests</h2>'+
    input("Search by name, phone or email","search",query.search,"type=search maxlength=150")+
    '<div class="split"><label class="field">Status<select name="status">'+option("","All statuses",query.status)+
    stages.map(stage=>option(stage,stage,query.status)).join("")+
    '</select></label><label class="field">Mode<select name="mode">'+option("","All modes",query.mode)+
    option("self","Self Registration",query.mode)+option("assisted","Assisted Onboarding",query.mode)+
    '</select></label></div>'+button("Apply Filters",'type="submit"')+'</form>'+
    (result.requests.length?result.requests.map(requestCard).join(""):panel("<p>No requests match your filters.</p>"))+
    '<div class="actions">'+(query.offset?action("Previous","previous",""):"")+
    (result.requests.length===100?action("Next","next",""):"")+'</div>';
  screen.innerHTML=navigation()+body;
}
function reviewMarkup(id,r) {
  const profile=r.profile;
  const detail=(title,value)=>value?'<p><strong>'+escape(title)+'</strong> · '+escape(value)+'</p>':"";
  const files=[...(profile.photos??[]),...(profile.documents??[])];
  return panel('<h4>Application details</h4>'+
    (Object.keys(profile).length?Object.entries({Type:profile.type,Address:profile.address,Area:profile.area,License:profile.license,
      Specialties:profile.specialties,Hours:profile.hours,Payout:profile.payout}).map(([k,v])=>detail(k,v)).join(""):"<p>Profile not yet completed.</p>")+
    (profile.latitude&&profile.longitude?detail("Map pin",profile.latitude+", "+profile.longitude):"")+
    (r.plan?detail("Plan",r.plan.name+" · "+r.plan.currency+" "+r.plan.price+" / "+r.plan.cycle):"")+
    (profile.doctors?.length?'<h4>Doctors</h4><ul>'+profile.doctors.map(d=>'<li>'+escape(d.name)+' · '+escape(d.specialty)+'</li>').join("")+'</ul>':"")+
    (files.length?'<h4>Private files</h4><ul>'+files.map(path=>'<li><button type="button" data-action="document" data-id="'+escape(id)+'" data-path="'+escape(path)+'">'+escape(path.split("/").at(-1))+'</button></li>').join("")+'</ul>':"")+
    '<h4>Stage history</h4><ul>'+r.history.map(h=>'<li>'+escape(h.status)+' · '+escape(date(h.at))+'</li>').join("")+'</ul>'+
    '<h4>Message log</h4>'+(r.messages.length?'<ul>'+r.messages.map(m=>'<li>'+escape(m.channel)+' · '+escape(m.template)+' · '+
      escape(m.sentAt?"Sent":m.failedAt?"Failed":"Queued")+' · '+escape(m.attempts)+' attempts'+
      (m.lastError?' · '+escape(m.lastError):"")+'</li>').join("")+'</ul>':"<p>No messages.</p>")+
    (r.history.at(-1)?.status==="Pending Approval"?'<form data-form="decision" data-id="'+escape(id)+'" class="stack">'+
      area("Reason (required to reject)","reason","","maxlength=3000")+
      '<div class="actions">'+button("Approve",'type="submit" value="approve"')+
      '<button type="submit" value="reject">Reject</button></div></form>':""));
}
let busy=false;
async function run(action) {
  if (busy) return;
  busy=true;err.textContent=status.textContent="";
  try { await action(); }
  catch(failure) {
    err.textContent=failure.message||"Action could not be completed.";
    if (failure.code==="42501") screen.innerHTML='<p><a href="../admin/">Sign in to Super Admin</a></p>';
  } finally { busy=false; }
}
async function send(id) {
  await edge(client,{action:"deliver",id,session:session()}).catch(()=>{});
}
screen.addEventListener("click",event=>{
  const control=event.target.closest("[data-action],[data-section]");
  if (!control) return;
  void run(async()=>{
    const {action:name,id,section:next}=control.dataset;
    if (next) {section=next;await draw();return;}
    if (name==="review") {
      const r=await admin("request",{id});
      control.closest("article").querySelector("[data-review]").innerHTML=reviewMarkup(id,r);
      return;
    }
    if (name==="document") {
      const result=await edge(client,{action:"document",id,path:control.dataset.path,session:session()});
      const link=document.createElement("a");
      link.href=result.url;link.textContent="Download file (expires in 1 minute)";
      control.replaceWith(link);return;
    }
    if (name==="next"||name==="previous") {query.offset+=name==="next"?100:-100;await draw();return;}
    if (name==="delete-plan"&&!confirm("Delete this subscription plan? Existing applications keep their selected plan.")) return;
    await admin(name==="delete-plan"?"plan_delete":name,{id});
    if (["resend","convert"].includes(name)) await send(id);
    await draw();status.textContent="Saved.";
  });
});
screen.addEventListener("submit",event=>{
  event.preventDefault();
  const form=event.target,fields=Object.fromEntries(new FormData(form)),id=form.dataset.id;
  void run(async()=>{
    if(form.dataset.form==="filters"){query={...fields,offset:0};await draw();return;}
    if(form.dataset.form==="plan"){
      const limits=Object.fromEntries(fields.limits.split("\n").filter(line=>line.trim()).map(line=>{
        const [key,...rest]=line.split("="), raw=rest.join("=").trim();
        if(!key.trim()||!raw) throw new Error("Enter limits as name=value, one per line.");
        return [key.trim(),Number.isFinite(Number(raw))?Number(raw):raw];
      }));
      await admin("plan_save",{id,active:fields.active==="true",details:{
        name:fields.name.trim(),price:Number(fields.price),currency:fields.currency.trim(),cycle:fields.cycle.trim(),
        features:fields.features.split("\n").map(x=>x.trim()).filter(Boolean),limits
      }});
    } else if(form.dataset.form==="template") await admin("template_save",{key:id,...fields});
    else if(form.dataset.form==="note") await admin("note",{id,note:fields.note});
    else {
      const name=event.submitter?.value;
      if(!["approve","reject"].includes(name)) return;
      if(name==="approve"&&!confirm("Approve and publish this provider to the patient app?")) return;
      await admin(name,{id,reason:fields.reason});
      await send(id);
    }
    await draw();status.textContent="Saved.";
  });
});
screen.textContent="Loading…";
void run(async()=>{
  client=connection({auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  if(!session()){screen.innerHTML='<p><a href="../admin/">Sign in to Super Admin</a></p>';return;}
  await draw();
});
