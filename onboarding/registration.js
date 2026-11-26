import { connection, screen, err, status, escape, input, area, button, option, data, edge, planCards } from "./common.js";

let client, invitation, user, record, plans=[], mode="self", planReady=false, saving=Promise.resolve(), debounce;
const bucket="banr-provider-uploads", tokenKey="banr-provider-invite";
const fragment=location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(fragment)) {
  sessionStorage.setItem(tokenKey,fragment);
  history.replaceState(null,"",location.pathname+location.search);
}
const token=()=>sessionStorage.getItem(tokenKey);
const rpc=(name,args)=>data(client.rpc(name,args));
const profile=(p_action,p_data={})=>rpc("banr_onboarding_profile",{p_action,p_data});
const panel=(content)=>'<section class="panel raised stack">'+content+'</section>';

function requestForm() {
  screen.innerHTML='<form class="panel raised stack" data-form="request">'+
    input("Facility name","facility","","required minlength=2 maxlength=120 placeholder='Rohan Clinic'")+
    input("Contact person name","contact","","required minlength=2 maxlength=100")+
    input("Contact number","phone","","required type=tel autocomplete=tel maxlength=24 placeholder='+91 9876543210'")+
    input("Email address","email","","required type=email autocomplete=email maxlength=254")+
    '<div class="segmented" role="group" aria-label="Onboarding mode">'+
    '<button type="button" data-mode="self" aria-pressed="true">Self Registration<br><small>I will register myself</small></button>'+
    '<button type="button" data-mode="assisted" aria-pressed="false">Assisted Onboarding<br><small>BNR team will onboard me</small></button></div>'+
    '<h2>Subscription plans</h2><div data-plans>Loading plans…</div>'+
    button("Send Request",'type="submit"')+'</form>'+
    panel('<a href="?resume=1">Resume a provider registration</a>');
}
function showPlans() {
  const list=screen.querySelector("[data-plans]");
  if (list) list.innerHTML=planReady ? planCards(plans) : "<p>Plans are temporarily unavailable. Your request can still be submitted.</p>";
}
function signIn() {
  const contact=invitation?.email;
  const email=input("Email address","email",contact,contact?'type=email readonly required':'type=email required autocomplete=email');
  screen.innerHTML='<form class="panel raised stack" data-form="account"><h2>'+
    (invitation ? "Register "+escape(invitation.facility) : "Resume registration")+'</h2>'+email+
    (invitation ? '<p>Phone to verify after email confirmation · '+escape(invitation.phone)+'</p>' : '')+
    input("Password","password","","type=password required maxlength=72")+'<div class="actions">'+
    (invitation?button("Create Account",'type="submit" value="register"'):"")+
    button("Sign In",'type="submit" value="login"')+'</div>'+
    (invitation?'<button type="button" data-action="verify-again">Send verification email again</button>':"")+'</form>';
}
const doctorRow=doctor=>'<fieldset data-doctor><legend>Doctor</legend>'+
  input("Name","doctorName",doctor?.name,"maxlength=100")+input("Specialty","doctorSpecialty",doctor?.specialty,"maxlength=100")+
  '<div class="split">'+input("Consultation fee (INR)","doctorFee",doctor?.fee,"type=number min=0 max=999999")+
  input("Consultation minutes","doctorMinutes",doctor?.minutes,"type=number min=1 max=999")+'</div><button type="button" data-action="remove-doctor">Remove doctor</button></fieldset>';
const fileRows=(key,paths)=>paths.map(path=>'<li>'+escape(path.split("/").slice(2).join("/"))+
  ' <button type="button" data-action="remove-file" data-kind="'+key+'" data-path="'+escape(path)+'">Remove</button></li>').join("");

function renderProfile() {
  if (!["Email Verified","Profile Completed"].includes(record.status)) {
    screen.innerHTML=panel('<h2>'+escape(record.facility)+'</h2><p>'+escape(record.status)+'</p>'+
      (record.reason?'<p>'+escape(record.reason)+'</p>':"")+(record.status==="Approved"?'<a href="../provider/">Open Provider Portal</a>':"")+
      '<button type="button" data-action="logout">Sign Out</button>');
    return;
  }
  const p=record.profile;
  const choices=record.plan && !plans.some(plan=>plan.id===record.plan.id) ? [...plans,record.plan] : plans;
  screen.innerHTML=panel('<h2>'+escape(record.facility)+'</h2><p>'+escape(user.email)+'</p>'+
    (record.phoneVerified?'<p>Mobile verified · '+escape(record.phone)+'</p>':
      '<p>Verify '+escape(record.phone)+' to submit the profile.</p>'+
      button("Send SMS code",'type="button" data-action="otp"')+
      '<form class="stack" data-form="otp" hidden>'+input("SMS code","otp","","required inputmode=numeric autocomplete=one-time-code maxlength=8")+button("Verify Phone",'type="submit"')+'</form>')+
    '<button type="button" data-action="logout">Sign Out</button>')+
    '<form class="panel raised stack" data-form="profile"><h2>Facility profile</h2><p>Your progress saves as you edit.</p>'+
    '<label class="field">Facility type<select name="type">'+option("","Choose type",p.type)+option("Clinic","Clinic",p.type)+option("Hospital","Hospital",p.type)+'</select></label>'+
    area("Full address","address",p.address,"maxlength=500")+input("Area or city","area",p.area,"maxlength=120")+
    '<div class="split">'+input("Map pin latitude","latitude",p.latitude,"type=number step=any min=-90 max=90")+
    input("Map pin longitude","longitude",p.longitude,"type=number step=any min=-180 max=180")+'</div>'+
    '<div class="actions"><button type="button" data-action="locate">Use current location</button><button type="button" data-action="map">Preview map pin</button></div><div data-map></div>'+
    input("Registration or license number","license",p.license,"maxlength=120")+
    area("Specialties","specialties",p.specialties,"maxlength=500")+input("Clinic hours","hours",p.hours,"maxlength=120")+
    '<h3>Doctors</h3><div class="stack" data-doctors>'+(p.doctors??[]).map(doctorRow).join("")+'</div>'+
    '<button type="button" data-action="add-doctor">Add doctor</button>'+
    input("Payout account reference or UPI ID","payout",p.payout,"maxlength=150")+
    ['photos','documents'].map(kind=>{
      const label=kind==="photos"?"Facility photos":"License documents";
      return '<label class="field">'+label+'<input type="file" data-upload="'+kind+'" multiple accept="'+
        (kind==="photos"?"image/jpeg,image/png,image/webp":"application/pdf,image/jpeg,image/png,image/webp")+
        '"></label><ul data-files="'+kind+'">'+fileRows(kind,p[kind]??[])+'</ul>';
    }).join("")+
    '<h3>Subscription plan</h3>'+planCards(choices)+
    '<label class="field">Choose a plan<select name="plan_id"><option value="">Select a plan</option>'+
    choices.map(plan=>option(plan.id,plan.name,record.plan?.id)).join("")+'</select></label>'+
    button("Submit for Approval",'type="submit"')+'</form>';
}

function currentProfile() {
  const form=screen.querySelector('[data-form="profile"]');
  if (!form) return null;
  const fields=Object.fromEntries(new FormData(form));
  const p=Object.fromEntries(["type","address","area","latitude","longitude","license","specialties","hours","payout"].map(k=>[k,fields[k]?.trim()??""]));
  p.doctors=Array.from(form.querySelectorAll("[data-doctor]"),row=>Object.fromEntries(
    Object.entries({name:"doctorName",specialty:"doctorSpecialty",fee:"doctorFee",minutes:"doctorMinutes"})
      .map(([key,name])=>[key,row.querySelector('[name="'+name+'"]').value.trim()])));
  p.photos=record.profile.photos??[];
  p.documents=record.profile.documents??[];
  return {profile:p,plan_id:fields.plan_id};
}
function save() {
  clearTimeout(debounce);
  const payload=currentProfile();
  if (!payload) return saving;
  saving=saving.catch(()=>{}).then(async()=>{
    status.textContent="Saving…";
    await profile("save",payload);
    status.textContent="Draft saved.";
  });
  return saving;
}
function scheduleSave() {
  clearTimeout(debounce);
  debounce=setTimeout(()=>void save().catch(report),650);
}
const report=failure=>{err.textContent=failure.message||"Something went wrong.";};
async function run(action,control) {
  if (control?.disabled) return;
  if (control) control.disabled=true;
  err.textContent="";
  try { await action(); } catch(failure) { report(failure); }
  finally { if (control) control.disabled=false; }
}
async function activate() {
  const result=await data(client.auth.getSession());
  user=result.session?.user;
  if (!user) { signIn(); return; }
  record=await profile("claim",{token:token()});
  if (!record) {
    screen.innerHTML=panel('<p>No provider application is linked to this account. Open your registration link to continue.</p><button type="button" data-action="logout">Sign Out</button>');
    return;
  }
  sessionStorage.removeItem(tokenKey);
  renderProfile();
}

screen.addEventListener("input", event=>{
  if(event.target.closest('[data-form="profile"]') && !event.target.dataset.upload) scheduleSave();
});
screen.addEventListener("submit", event=>{
  event.preventDefault();
  const form=event.target, fields=Object.fromEntries(new FormData(form));
  void run(async()=>{
    if (form.dataset.form==="request") {
      const number=fields.phone.replace(/[ .()-]/g,"");
      if (!/^\d{10}$|^\+[1-9]\d{10,14}$/.test(number)) throw new Error("Enter a 10-digit mobile number or include the country code.");
      status.textContent="Sending your request…";
      let result;
      try { result=await edge(client,{action:"submit", ...fields, mode}); }
      finally { status.textContent=""; }
      screen.innerHTML=panel('<h2>Request received</h2><p>'+
        (mode==="assisted"?"Our team will contact you shortly.":result.sent?
         "Link sent to your phone and email.":"Your request is saved. Link delivery is pending. Check your phone and email later.")+'</p><a href="../">Back to Home</a>');
    } else if (form.dataset.form==="account") {
      if (event.submitter?.value==="register") {
        const result=await edge(client,{action:"register",token:token(),password:fields.password});
        form.reset();
        status.textContent=result.sent ? "Check your email to verify your account, then sign in." : "Account created. Verification email delivery is pending.";
      } else {
        await data(client.auth.signInWithPassword({email:fields.email.trim(),password:fields.password}));
        await activate();
      }
    } else if (form.dataset.form==="otp") {
      clearTimeout(debounce);
      await data(client.auth.verifyOtp({phone:record.phone,token:fields.otp.trim(),type:"phone_change"}));
      await save();
      record=await profile("load");
      renderProfile();
    } else {
      await save();
      record=await profile("submit",currentProfile());
      status.textContent="Application submitted for review.";
      renderProfile();
    }
  },event.submitter);
});

screen.addEventListener("change",event=>{
  const field=event.target, kind=field.dataset.upload;
  if (!kind || !field.files.length) return;
  void run(async()=>{
    const paths=record.profile[kind]??[];
    if (paths.length+field.files.length>20) throw new Error("Upload up to 20 files in each section.");
    for (const file of field.files) {
      const validTypes=kind==="photos"?["image/jpeg","image/png","image/webp"]:["image/jpeg","image/png","image/webp","application/pdf"];
      if (!validTypes.includes(file.type) || file.size>10*1024*1024) throw new Error("Choose an allowed image or PDF up to 10 MB.");
    }
    for (const file of field.files) {
      const path=user.id+"/"+crypto.randomUUID()+"/"+file.name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-100);
      await data(client.storage.from(bucket).upload(path,file));
      paths.push(path);
      record.profile[kind]=paths;
    }
    screen.querySelector('[data-files="'+kind+'"]').innerHTML=fileRows(kind,paths);
    field.value="";
    await save();
  },field);
});

screen.addEventListener("click",event=>{
  const target=event.target.closest("[data-action],[data-mode]");
  if (!target) return;
  if (target.dataset.mode) {
    mode=target.dataset.mode;
    for(const tab of screen.querySelectorAll("[data-mode]")) tab.setAttribute("aria-pressed",String(tab===target));
    return;
  }
  void run(async()=>{
    switch(target.dataset.action) {
      case "otp":
        await data(client.auth.updateUser({phone:record.phone}));
        screen.querySelector('[data-form="otp"]').hidden=false;
        status.textContent="SMS code sent.";
        break;
      case "verify-again": {
        const result=await edge(client,{action:"verify_again",token:token()});
        status.textContent=result.sent?"Verification email sent.":"Verification email queued.";
        break;
      }
      case "logout":
        await save();
        await data(client.auth.signOut({scope:"local"}));
        user=null; record=null; signIn(); break;
      case "add-doctor":
        screen.querySelector("[data-doctors]").insertAdjacentHTML("beforeend",doctorRow()); scheduleSave(); break;
      case "remove-doctor":
        target.closest("[data-doctor]").remove(); scheduleSave(); break;
      case "remove-file": {
        const key=target.dataset.kind;
        record.profile[key]=record.profile[key].filter(path=>path!==target.dataset.path);
        target.closest("li").remove(); await save(); break;
      }
      case "locate": {
        if (!navigator.geolocation) throw new Error("Enter coordinates manually.");
        const result=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{timeout:10000}))
          .catch(()=>{throw new Error("Location unavailable. Enter coordinates manually.");});
        screen.querySelector('[name="latitude"]').value=result.coords.latitude.toFixed(6);
        screen.querySelector('[name="longitude"]').value=result.coords.longitude.toFixed(6);
        scheduleSave();
        break;
      }
      case "map": {
        const p=currentProfile().profile, lat=Number(p.latitude), lng=Number(p.longitude);
        if (!p.latitude||!p.longitude||!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) throw new Error("Enter valid map coordinates.");
        const url=new URL("https://www.openstreetmap.org/export/embed.html");
        url.searchParams.set("bbox",[lng-.006,lat-.003,lng+.006,lat+.003].join(","));
        url.searchParams.set("marker",[lat,lng].join(","));
        const map=document.createElement("iframe"); map.title="Facility map pin"; map.className="map-pin"; map.src=url.href; map.referrerPolicy="no-referrer";
        screen.querySelector("[data-map]").replaceChildren(map);
        break;
      }
    }
  },target);
});

async function start() {
  client=connection({auth:{storageKey:"banr-provider-onboarding"}});
  const resume=new URLSearchParams(location.search).has("resume");
  if (!resume&&!token()&&!location.hash&&!new URLSearchParams(location.search).has("code")) {
    const {session}=await data(client.auth.getSession());
    if (session) {
      try { record=await profile("claim"); } catch {}
      if (record) {
        user=session.user;
        plans=await rpc("banr_onboarding_plans").catch(()=>[]);
        renderProfile();return;
      }
    }
    requestForm();
    try { plans=await rpc("banr_onboarding_plans"); planReady=true; } finally { showPlans(); }
    return;
  }
  const session=await data(client.auth.getSession());
  if (token()) invitation=await rpc("banr_onboarding_open",{p_token:token()});
  if (!invitation&&token()&&!session.session) { sessionStorage.removeItem(tokenKey); throw new Error("This registration link expired or was already used."); }
  plans=await rpc("banr_onboarding_plans").catch(()=>[]);
  await activate();
}
screen.textContent="Loading…";
void start().catch(failure=>{screen.replaceChildren();report(failure);});
