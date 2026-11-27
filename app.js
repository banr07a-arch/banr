import { attribution, distanceKm, openingStatus, nearbyDirectory, combineDirectory } from "./discovery.js";
import { currentLocality, searchLocations } from "./location-selector.js";
import { patientDefaults, contentWithDefaults, httpsUrl } from "./managed-content.js";
let content = patientDefaults;
import { backend, live, walkInSms } from "./backend.js";
const icons={
 home:'<path d="m3 10 9-7 9 7v10h-6v-7H9v7H3z"/>',
 ticket:'<path d="M3 5h18v4a3 3 0 0 0 0 6v4H3v-4a3 3 0 0 0 0-6z"/><path d="M14 8h.01m0 4h.01m0 4h.01"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 11h18m-13 4h.01m4 0h.01m4 0h.01"/>',
 user:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2z"/>',
 bell:'<path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0"/>',
 pin:'<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2.5"/>',
 search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
 chevron:'<path d="m9 5 7 7-7 7"/>',down:'<path d="m6 9 6 6 6-6"/>',back:'<path d="m15 5-7 7 7 7"/>',
 general:'<path d="M5 3v6a5 5 0 0 0 10 0V3M3 3h4m6 0h4m-7 11v3a4 4 0 0 0 8 0v-2"/><circle cx="18" cy="12" r="2"/>',
 dentist:'<path d="M12 5c-3-4-9-1-8 4 .3 2 2 3 2 7 0 3 1 5 3 5 1-1 1-6 3-6s2 5 3 6c2 0 3-2 3-5 0-4 1.7-5 2-7 1-5-5-8-8-4z"/>',
 check:'<path d="m5 12 4 4L19 6"/>'
};
const icon=(name,kind="")=>'<svg class="icon '+kind+'" viewBox="0 0 24 24" aria-hidden="true">'+icons[name]+'</svg>';
let facilities=live?[]:[
 {id:"raj",name:"Raj Clinic",type:"Clinic",distance:"1.2 km",hours:"9:00 AM – 8:00 PM",img:"clinic",area:"Andheri East, Mumbai",doctors:[{name:"Dr. Rahul Sharma",specialty:"General Physician",fee:500},{name:"Dr. Kavya Mehta",specialty:"Dentist",fee:650}]},
 {id:"aman",name:"Aman Hospital",type:"Hospital",distance:"2.8 km",hours:"24 × 7",img:"hospital",area:"Vile Parle East, Mumbai",doctors:[{name:"Dr. Neha Shah",specialty:"Gynaecologist",fee:750},{name:"Dr. Arjun Rao",specialty:"General Surgeon",fee:800}]}
];
const demoSessions=[{name:"Morning",hours:"9:30 AM – 12:30 PM"},{name:"Evening",hours:"5:00 PM – 8:00 PM"}];
const screen=document.getElementById("screen");
const topbar=document.getElementById("top");
const nav=document.getElementById("navigation");
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const load=(key,fallback)=>{try{return JSON.parse(localStorage.getItem("banr.demo."+key))??fallback}catch{return fallback}};
const save=(key,value)=>{try{localStorage.setItem("banr.demo."+key,JSON.stringify(value))}catch{}};
let profile=live?null:load("profile",null),bookings=live?[]:load("bookings",[]),phone=live?"":load("phone",""),locationName=load("location","Mumbai");
let user=null, availableSessions=[], busy=false, loadError="", catalogError="", accountError="", queueError="", scheduleLoading=false, scheduleRequest=0;
const formatTime=value=>new Intl.DateTimeFormat("en-IN",{hour:"numeric",minute:"2-digit",timeZone:"Asia/Kolkata"}).format(new Date(value));
const dateKey=value=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata"}).format(new Date(value));
const active=b=>!live||(!["completed","no_show","cancelled"].includes(b.status)&&b.opd_status!=="closed"&&Date.parse(b.ends_at)>Date.now());
const sessionOptions=()=>live?availableSessions.filter(s=>dateKey(s.starts_at)===selected.date):demoSessions;
const sessionHours=s=>live?formatTime(s.starts_at)+" – "+formatTime(s.ends_at):s.hours;
const sessionUnavailable=s=>{
 if(!s)return "Choose a session";
 if(!live)return "";
 if(s.status==="closed"||Date.parse(s.ends_at)<=Date.now())return "Session ended";
 if(s.booked_count>=s.capacity)return "Fully booked";
 return "";
};
const available=s=>!sessionUnavailable(s);
const sessionStatus=s=>({open:"OPD Live",paused:"OPD Paused",late:"OPD Delayed",scheduled:"OPD Scheduled"})[s.status]??"";
const sessionLabel=s=>s.name+" · "+sessionHours(s)+(live?" · "+(sessionUnavailable(s)||sessionStatus(s)):"");
const waitEstimate=b=>{
 if(!live){
  const ahead=Math.max(0,b.token-b.current-1);
  return {ahead,minutes:b.current>=b.token?0:ahead*3+2};
 }
 if(b.status==="serving")return {ahead:0,minutes:0};
 const start=b.opd_status==="late"?b.revised_start_at:b.starts_at;
 const remaining=b.opd_status==="scheduled"||b.opd_status==="late"
  ? (start?Math.max(0,(Date.parse(start)-Date.now())/60000):null)
  : b.current_started_at ? Math.max(0,b.consultation_minutes-(Date.now()-Date.parse(b.current_started_at))/60000) : 0;
 return {ahead:b.patients_ahead,minutes:b.opd_status==="paused"||remaining==null?null:Math.ceil(remaining+b.patients_ahead*b.consultation_minutes)};
};
let page="home",previous=[],selected={},activeBooking=null,authReturn="details",pendingPhone="",query="",category="",historyTab="upcoming";
const urlParams=new URLSearchParams(location.search);
let walkInFacility=urlParams.get("facility");
let discoveryCenter=load("location-center",null);
if(!discoveryCenter && locationName==="Mumbai")discoveryCenter={latitude:19.076,longitude:72.8777};
let discoveryRequest, directoryStatus="", externalFacilities=[], storedFacilities=[], openOnly=false, radius=0, sortBy="distance", department="";
let directoryAliases=[];
const canBook=f=>Boolean(f&&(!live||(f.booking_enabled&&f.accepts_online&&!f.directory_only)));
function refreshDiscovery(){
 if(!live||!discoveryCenter)return;
 discoveryRequest?.abort();
 const request=discoveryRequest=new AbortController();
 directoryStatus="Loading nearby facilities…";
 const center=discoveryCenter, label=locationName;
 const update=()=>{const target=screen.querySelector("#results");if(page==="home"&&target)target.innerHTML=results();};
 update();
 void nearbyDirectory(center,label,request.signal).then(rows=>{
  if(request.signal.aborted)return;
  externalFacilities=rows.filter(row=>!directoryAliases.some(alias=>alias.external_place_id===row.external_place_id));
  facilities=combineDirectory(storedFacilities,externalFacilities);
  directoryStatus="";
 }).catch(()=>{
  if(!request.signal.aborted)directoryStatus="Nearby map listings are temporarily unavailable. Showing the BANR directory.";
 }).finally(()=>{if(!request.signal.aborted)update();});
}
const facility=()=>facilities.find(item=>item.id===selected.facility);
const doctor=()=>facility()?.doctors[selected.doctor];
const signedIn=()=>live?Boolean(user):Boolean(phone);
const loginLabel=live?"Email Login":"Mobile OTP Login";
const appointments=()=>!signedIn()?[]:live?bookings:bookings.filter(b=>b.phone===phone);
const walkins=()=>appointments().filter(b=>b.facility===walkInFacility&&b.source==="walkin"&&active(b));
const dayKey=(offset=0)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata"}).format(new Date(Date.now()+86400000*offset));
const prettyDay=date=>new Intl.DateTimeFormat("en-IN",{weekday:"short",day:"numeric",month:"short",timeZone:"Asia/Kolkata"}).format(new Date(date+"T12:00:00+05:30"));
const pageTitle=title=>'<h1 class="pagehead" tabindex="-1">'+esc(title)+'</h1>';
const btn=(label,action,cls="primary")=>'<button type="button" class="'+cls+'" data-action="'+action+'">'+label+'</button>';
const demo='<p class="notice">Interactive demo · sample clinics and queues. Use sample details only.</p>';
const images={
 hero:new URL("./assets/hero.webp",import.meta.url).href,
 clinic:new URL("./assets/clinic.webp",import.meta.url).href,
 hospital:new URL("./assets/hospital.webp",import.meta.url).href
};
const image=(name,alt)=>'<img src="'+images[name]+'" alt="'+alt+'">';
function go(next,reset=false){
 if(reset) previous=[]; else if(page!==next) previous.push(page);
 page=next;
 render();
 scrollTo(0,0);
 screen.querySelector("h1")?.focus({preventScroll:true});
}
const brandEmblem = new URL("./assets/banr-official-logo.jpg", import.meta.url).href;
function shell(){
 const compact = page==="home";
 topbar.classList.toggle("compact-home-header",compact);
 const back = previous.length?btn(icon("back"),"back","iconbtn"):"<span></span>";
 const bell = '<button class="iconbtn" type="button" data-action="notifications" aria-label="Notifications">'+icon("bell")+'</button>';
 topbar.innerHTML=compact
  ? '<span class="patient-brand-emblem"><img src="'+brandEmblem+'" alt="BANR" width="720" height="540"></span>'+bell
  : back+'<div><div class="brand">BANR</div><div class="subtitle">'+esc(content.subtitle)+'</div></div>'+bell;
 topbar.querySelector('[data-action=back]')?.setAttribute("aria-label","Go back");
 const current=["token","appointments","account"].includes(page)?page:"home";
 nav.innerHTML=[["home","home","Home"],["token","ticket","My Token"],["appointments","calendar","Appointments"],["account","user","Account"]].map(([id,img,label])=>
 '<button type="button" data-action="nav:'+id+'" '+(current===id?'aria-current="page"':'')+'>'+icon(img)+label+'</button>').join("");
}
function formattedDistance(item){
 const distance=distanceKm(discoveryCenter,item);
 return Number.isFinite(distance) ? (distance<1?Math.round(distance*1000)+" m":distance.toFixed(1)+" km")+" away (approx.)" : "";
}
function card(item){
 const specialties=item.specialties||item.doctors.filter(d=>d.available_for_booking!==false).map(d=>d.specialty).join(", ");
 const photo=httpsUrl(item.photo_url), open=openingStatus(item.structuredHours || item.hours);
 const summary=[formattedDistance(item)||item.distance||item.area,open===null?item.hours:open?"Open now":"Closed now"].filter(Boolean).join(" · ");
 return '<button class="facility raised" data-action="facility:'+esc(item.id)+'">'+
 (photo?'<figure><img src="'+esc(photo)+'" alt="" loading="lazy"></figure>':live?'':'<figure>'+image(item.img,"")+'</figure>')+
 '<div><h3>'+esc(item.name)+'</h3><p>'+esc(summary)+'</p>'+
 (canBook(item)?'<span class="tag">Accepting appointments on BANR</span>':'')+
 (specialties?'<p>'+esc(specialties)+'</p>':'')+'</div>'+icon("chevron","chev")+'</button>';
}
function results(){
 const value=query.trim().toLowerCase();
 const matches=facilities.filter(f=>{
  const haystack=[f.name,f.area,f.address,f.type,f.specialties,...f.doctors.flatMap(d=>[d.name,d.specialty])].join(" ").toLowerCase().replaceAll("gynae","gyne");
  const distance=distanceKm(discoveryCenter,f);
  const nearby=f.external||f.area.toLowerCase().includes(locationName.toLowerCase())||
   f.address?.toLowerCase().includes(locationName.toLowerCase())||(distance<=10);
  return (!category||haystack.includes(category.toLowerCase().replaceAll("gynae","gyne")))&&(!value||haystack.includes(value))
   &&(!live||value||nearby)&&(!radius||distance<=radius)&&(!openOnly||openingStatus(f.structuredHours||f.hours)===true);
 });
 const compareDistance=(a,b)=>distanceKm(discoveryCenter,a)-distanceKm(discoveryCenter,b)||a.name.localeCompare(b.name);
 const rank=f=>value?(f.name.toLowerCase()===value?0:f.name.toLowerCase().startsWith(value)?1:f.name.toLowerCase().includes(value)?2:3):0;
 matches.sort((a,b)=>(sortBy==="relevance"?rank(a)-rank(b):0)||compareDistance(a,b));
 const note=(catalogError?'<p role="alert">'+esc(catalogError)+' '+btn("Retry","retry-catalog","link")+'</p>':'')+
  (directoryStatus?'<p class="small" role="status">'+esc(directoryStatus)+'</p>':'')+
  (externalFacilities.length?'<p class="small"><a href="'+attribution+'" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a></p>':'');
 if(value||category||openOnly||radius) return '<div class="sectionhead"><h2>'+(esc(category)||"Search results")+'</h2>'+btn("Clear","clear","link")+'</div>'+
  (matches.length?matches.map(card).join(""):'<p class="panel raised">No clinics or hospitals match your search.</p>')+note;
 return [["Clinic","Nearby clinics"],["Hospital","Nearby hospitals"]].map(([type,title])=>
 '<div class="sectionhead"><h2>'+title+'</h2>'+btn("View More","filter:"+type,"link")+'</div>'+
 (matches.filter(f=>f.type===type).slice(0,6).map(card).join("")||'<p class="small">No listings found in this area.</p>')).join("")+note;
}
function directoryFilters(){
 if(!live)return "";
 return '<div class="chips" aria-label="Directory filters">'+btn("Clinics","filter:Clinic","chip")+btn("Hospitals","filter:Hospital","chip")+
 '<button type="button" class="chip" data-action="open-filter" aria-pressed="'+openOnly+'">Open now</button>'+
 '<label class="field">Distance<select id="distance-filter">'+[0,2,5,10].map(k=>'<option value="'+k+'" '+(k===radius?"selected":"")+'>'+(k?"Within "+k+" km":"Any distance")+'</option>').join("")+'</select></label>'+
 '<label class="field">Sort<select id="sort-directory"><option value="distance" '+(sortBy==="distance"?"selected":"")+'>Distance</option><option value="relevance" '+(sortBy==="relevance"?"selected":"")+'>Relevance</option></select></label></div>';
}
const resourcePages = [
 ["help","Help Center"], ["support","Contact support"], ["experts","Expert Q&A"], ["privacy","Privacy Policy"], ["refund","Refund Policy"], ["about","About BANR"],
];
let reviewedAnswers;
function loadReviewedAnswers(){
 reviewedAnswers = content.expertAnswers.filter(item=>
 item.review?.status==="reviewed" && item.review.verified === true &&
 item.review.name && item.review.credential && item.review.date &&
 item.topic && item.question && item.answer);
}
loadReviewedAnswers();
const expertEmpty = "No reviewed answers are available yet.";
let bannerIndex=0, expertTopic="", expertAnswerIndex=null;

function managedBanner(slide){
 const imageUrl=httpsUrl(slide.imageUrl), link=httpsUrl(slide.link);
 if(imageUrl&&slide.imageLayout==="full"){
  const artwork='<img src="'+esc(imageUrl)+'" alt="'+esc(slide.title+(slide.description?' · '+slide.description:''))+'">';
  return '<section class="hero hero-uploaded">'+(link?'<a href="'+esc(link)+'" rel="noopener noreferrer" target="_blank">'+artwork+'</a>':artwork)+
   (slide.sponsored===true?'<p class="sponsored">Sponsored</p>':'')+'</section>';
 }
 return '<section class="hero">'+(imageUrl?'<img src="'+esc(imageUrl)+'" alt="">':'')+
 '<h2>'+esc(slide.title)+'</h2><p>'+esc(slide.description)+'</p>'+
 (slide.sponsored===true?'<p class="sponsored">Sponsored</p>':'')+
 (link?'<p><a href="'+esc(link)+'" rel="noopener noreferrer" target="_blank">Learn more</a></p>':'')+'</section>';
}
function homeBanners(){
 const banners=[
  content.hero?managedBanner(content.hero):'<section class="hero">'+image("hero","")+'<h2>Skip the Wait,<br>Book Your OPD<br>with <strong>BANR</strong></h2><p>✓ Live Token &nbsp; ✓ Wait Time &nbsp; ✓ Easy Booking</p></section>',
  ...content.promotions.map(managedBanner),
 ];
 return '<section aria-label="Home banners"><div class="banner-track" tabindex="0" aria-label="Swipe or use the slide buttons to browse banners">'+
 banners.map((banner,index)=>'<div class="banner-slide" aria-label="Slide '+(index+1)+' of '+banners.length+'">'+banner+'</div>').join("")+
 '</div><div class="dots">'+banners.map((_,index)=>
 '<button type="button" data-banner="'+index+'" aria-label="Show slide '+(index+1)+'" aria-pressed="'+(index===bannerIndex)+'"></button>').join("")+'</div></section>';
}

function connectHomeBanners(){
 const track=screen.querySelector(".banner-track");
 const dots=[...screen.querySelectorAll("[data-banner]")];
 let pendingSlide=null;
 const select=(index,behavior)=>{
  bannerIndex=index;
  dots.forEach((dot,i)=>dot.setAttribute("aria-pressed",String(i===index)));
  track.scrollTo({left:track.children[index].offsetLeft,behavior});
 };
 select(bannerIndex,"instant");
 dots.forEach((dot,index)=>dot.addEventListener("click",()=>{
  pendingSlide=index;
  select(index,matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth");
 }));
 track.addEventListener("scroll",()=>{
  const index=Math.min(dots.length-1,Math.max(0,Math.round(track.scrollLeft/track.clientWidth)));
  if(pendingSlide!==null&&index!==pendingSlide)return;
  pendingSlide=null;
  bannerIndex=index;
  dots.forEach((dot,i)=>dot.setAttribute("aria-pressed",String(i===index)));
 },{passive:true});
 track.addEventListener("pointerdown",()=>{pendingSlide=null;});
 track.addEventListener("keydown",()=>{pendingSlide=null;});
}

function expertRows(items){
 return items.map(item=>'<article class="panel raised stack"><p class="subtle">'+esc(item.topic)+'</p>'+
 btn(esc(item.question),"expert-answer:"+reviewedAnswers.indexOf(item),"chip")+'</article>').join("");
}
function experts(){
 const topics=[...new Set(reviewedAnswers.map(item=>item.topic))].sort();
 const items=expertTopic?reviewedAnswers.filter(item=>item.topic===expertTopic):reviewedAnswers;
 return pageTitle("Expert Q&A")+(topics.length?
 '<div class="chips">'+["",...topics].map((topic,index)=>'<button type="button" class="chip" data-action="expert-topic:'+index+
 '" aria-pressed="'+(topic===expertTopic)+'">'+esc(topic||"All topics")+'</button>').join("")+'</div>'+expertRows(items):
 '<p class="panel raised">'+expertEmpty+'</p>');
}
function expertAnswer(){
 const item=reviewedAnswers[expertAnswerIndex];
 if(!item)return experts();
 return pageTitle(item.question)+'<article class="panel raised stack"><p class="subtle">'+esc(item.topic)+'</p>'+
 item.answer.split(/\n\s*\n/).map(paragraph=>'<p>'+esc(paragraph)+'</p>').join("")+
 '<p class="notice">Reviewed by '+esc(item.review.name)+' · '+esc(item.review.credential)+' · '+esc(item.review.date)+'</p></article>';
}
function help(){
 return pageTitle("Help Center")+'<section class="stack">'+content.helpFAQs.map(([question,answer])=>
 '<details class="panel raised faq"><summary>'+esc(question)+'</summary><p>'+esc(answer)+'</p></details>').join("")+
 (content.supportEmail?'<p class="panel raised">BANR support <a href="mailto:'+esc(content.supportEmail)+'">'+esc(content.supportEmail)+'</a></p>':
 '<p class="notice">For help with an existing visit, contact your clinic or hospital reception.</p>')+'</section>';
}
function privacy(){
 return pageTitle("Privacy Policy")+'<section class="panel raised stack">'+content.privacySections.map(([heading,copy])=>
 '<div><h2>'+esc(heading)+'</h2><p>'+esc(copy)+'</p></div>').join("")+
 (content.supportEmail?'<p>Privacy questions <a href="mailto:'+esc(content.supportEmail)+'">'+esc(content.supportEmail)+'</a></p>':'')+'</section>';
}
function refund(){
 return pageTitle("Refund Policy")+'<section class="panel raised stack">'+(content.refundTerms.length?
 content.refundTerms.map(copy=>'<p>'+esc(copy)+'</p>').join(""):
 '<p class="notice">Draft · Refund terms are awaiting approval.</p>')+'</section>';
}
function about(){
 return pageTitle("About BANR")+'<section class="panel raised stack">'+
 content.about.map(copy=>'<p>'+esc(copy)+'</p>').join("")+'</section>';
}
function joinProvider(){
 const imageUrl=httpsUrl(content.providerBanner?.imageUrl);
 const artwork=imageUrl?'<img class="provider-join-artwork" src="'+esc(imageUrl)+'" alt="" loading="lazy">':'';
 return '<a class="panel raised stack provider-join" href="/onboarding/">'+artwork+'<strong>Register Your Facility</strong><span>Enable online appointments, live token tracking and OPD management for your clinic or hospital.</span></a>';
}
function home(){
 return '<div class="intro row"><h1 tabindex="-1">Home</h1>'+btn(icon("pin")+esc(locationName)+icon("down"),"location","place raised")+'</div>'+
 '<label class="search raised">'+icon("search")+'<input id="search" type="search" aria-label="Search doctors, clinics and hospitals" value="'+esc(query)+'" placeholder="Search doctors, clinics, hospitals…"></label>'+
 homeBanners()+joinProvider()+directoryFilters()+
 '<div class="sectionhead"><h2>Find a doctor by specialty</h2>'+btn("View All","specialties","link")+'</div>'+
 '<div class="specials">'+[["General","general","General"],["Physician","user","Physician"],["Dentist","dentist","Dentist"],["Gynaecology","user","Gyne"]].map(([label,img,value])=>btn(icon(img)+label,"filter:"+value,"tile raised")).join("")+'</div>'+
 '<div id="results">'+results()+'</div>'+(live?'':demo);
}
let facilitySessions=null, facilityStatusRequest=0;
async function refreshFacilitySessions(f){
 const request=++facilityStatusRequest;
 try{
  const rows=await backend.facilitySessions(f.doctors.map(d=>d.id),dayKey());
  if(request!==facilityStatusRequest||page!=="facility"||facility()?.id!==f.id)return;
  facilitySessions=rows;
 }catch{
  if(request!==facilityStatusRequest||page!=="facility"||facility()?.id!==f.id)return;
  facilitySessions=false;
 }
 render();
}
function doctorOpdStatus(id){
 if(facilitySessions===null)return "Checking today’s OPD…";
 if(facilitySessions===false)return "Today’s OPD status unavailable";
 const today=facilitySessions.filter(s=>s.doctor_id===id);
 const now=Date.now();
 const current=today.find(s=>Date.parse(s.starts_at)<=now&&now<Date.parse(s.ends_at)&&s.status!=="closed");
 const upcoming=today.find(s=>Date.parse(s.starts_at)>now&&s.status!=="closed");
 const session=current||upcoming;
 if(!session)return today.length?"OPD closed for today":"No OPD scheduled today";
 const status=current?{open:"OPD Live",paused:"OPD Paused",late:"OPD Delayed",scheduled:"OPD Not Started"}[session.status]:"OPD Scheduled";
 const availability=today.some(available);
 return status+" · "+sessionHours(session)+" · "+(availability?"Today’s booking available":"Fully booked today");
}
function detail(){
 const f=facility();
 if(!f)return pageTitle("Facility unavailable");
 const map=httpsUrl(f.maps_url)||(live?'https://www.google.com/maps/search/?api=1&query='+
  encodeURIComponent(f.latitude!=null&&f.longitude!=null?f.latitude+","+f.longitude:[f.name,f.address||f.area].join(", ")):"");
 const website=httpsUrl(f.website), photo=httpsUrl(f.photo_url);
 const dial=(f.contact??"").replace(/[ .()-]/g,"");
 const contact=/^\+?\d{8,15}$/.test(dial)?'<a class="link" href="tel:'+esc(dial)+'">Call '+esc(f.contact)+'</a>':'';
 const hours=openingStatus(f.structuredHours||f.hours);
 const booking=canBook(f);
 const core=pageTitle(f.name)+'<section class="panel raised stack">'+
 (photo?'<div class="photo"><img src="'+esc(photo)+'" alt=""></div>':live?'':'<div class="photo">'+image(f.img,"")+'</div>')+
 '<p>'+esc(f.address||f.area||"Address unavailable")+'</p>'+(formattedDistance(f)?'<p>'+esc(formattedDistance(f))+'</p>':'')+
 '<p>'+esc(f.hours||"Opening hours unavailable")+(hours===null?"":hours?" · Open now":" · Closed now")+'</p>'+
 (f.specialties?'<p>'+esc(f.specialties)+'</p>':'')+contact+
 (map?'<a class="link" href="'+esc(map)+'" target="_blank" rel="noopener noreferrer">View map and directions</a>':'')+
 (website?'<a class="link" href="'+esc(website)+'" target="_blank" rel="noopener noreferrer">Website</a>':'')+
 (f.external?'<a class="small" href="'+esc(f.source_url)+'" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>':'')+
 (booking?'<p class="tag">Accepting appointments on BANR</p>':
  '<p class="notice">OPD booking is unavailable on BANR for this facility.</p>'+
  (!f.booking_enabled?'<a class="link" href="/onboarding/?'+(f.external?'source='+encodeURIComponent(f.external_place_id):'claim='+encodeURIComponent(f.id))+'">Register or claim this facility</a>':''))+
 '</section>';
 if(!booking)return core;
 const specialties=[...new Set(f.doctors.filter(d=>d.available_for_booking!==false).map(d=>d.specialty))];
 const filter=f.type==="Hospital"&&specialties.length>1?'<label class="field">Department<select id="facility-department">'+
  '<option value="">All specialties</option>'+specialties.map(s=>'<option '+(department===s?"selected":"")+'>'+esc(s)+'</option>').join("")+'</select></label>':"";
 return core+'<h2>Doctors at '+esc(f.name)+'</h2>'+filter+
 f.doctors.map((d,index)=>d.available_for_booking===false||(department&&d.specialty!==department)?"":
 '<article class="panel raised stack"><h3>'+esc(d.name)+'</h3><p class="subtle">'+esc(d.specialty)+' · '+(d.fee==null?"Fee unavailable":"₹"+esc(d.fee))+'</p>'+
 (live?'<p class="tag">'+doctorOpdStatus(d.id)+'</p>':'')+btn("Book Appointment","book:"+index)+'</article>').join("");
}
function schedule(){
 const dates=live?[...new Set(availableSessions.map(s=>dateKey(s.starts_at)))]:[0,1,2,3].map(dayKey);
 const sessionList=sessionOptions();
 const body=scheduleLoading?'<p>Loading OPD sessions…</p>':loadError?'<p role="alert">'+esc(loadError)+'</p>'+btn("Retry","retry-schedule","link"):
 !dates.length?'<p>No upcoming sessions for this doctor.</p>':
 '<div><h3>Choose a date</h3><div class="chips">'+dates.map(date=>'<button class="chip" data-action="date:'+date+'" aria-pressed="'+(selected.date===date)+'">'+(date===dayKey()?"Today · ":"")+prettyDay(date)+'</button>').join("")+'</div></div>'+
 '<div><h3>Choose a session</h3><div class="stack">'+sessionList.map((s,i)=>'<button class="chip" data-action="session:'+i+'" aria-pressed="'+(selected.session===i)+'" '+(available(s)?'':'disabled')+'>'+esc(sessionLabel(s))+'</button>').join("")+'</div></div>'+
 '<button class="primary full" data-action="continue" '+(selected.session==null||!available(sessionList[selected.session])?"disabled":"")+'>Continue</button>';
 return pageTitle("Book Appointment")+'<div class="panel raised stack"><h2>'+esc(doctor().name)+'</h2><p>'+esc(facility().name)+' · ₹'+doctor().fee+'</p>'+body+'</div>';
}
async function openSchedule(){
 const request=++scheduleRequest;
 loadError="";
 availableSessions=[];
 scheduleLoading=live;
 selected.session=null;
 go("schedule");
 if(!live)return;
 try{
  const lastDay=dayKey(facility().advance_booking_days??7);
  const sessions=(await backend.sessions(doctor().id)).filter(session=>dateKey(session.starts_at)<=lastDay);
  if(request!==scheduleRequest)return;
  availableSessions=sessions;
  const firstAvailable=sessions.find(available)??sessions[0];
  selected.date=firstAvailable?dateKey(firstAvailable.starts_at):"";
 }catch{
  if(request===scheduleRequest)loadError="Could not load OPD sessions.";
 }finally{
  if(request===scheduleRequest){scheduleLoading=false;if(page==="schedule")render();}
 }
}
function login(){
 const liveWalkIn=walkInSms&&authReturn==="walkin";
 if(live&&!liveWalkIn)return pageTitle("Email Login")+
 '<form class="panel raised stack" data-form="email-login">'+
 '<label class="field">Email<input type="email" name="email" autocomplete="email" required></label>'+
 '<label class="field">Password<input type="password" name="password" autocomplete="current-password" required></label>'+
 '<p class="err" id="form-error" role="alert"></p><p id="form-status" role="status"></p>'+
 '<button class="primary" type="submit" value="signin">Sign In</button>'+
 '<button class="primary" type="submit" value="signup">Create Account</button></form>';

 return pageTitle(pendingPhone?"Verify mobile number":"Mobile OTP Login")+
 '<form class="panel raised stack" data-form="otp">'+
 (pendingPhone?'<p>Verifying +91 '+esc(pendingPhone)+'</p><label class="field">OTP<input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>'+(live?'':'<p class="notice">Demo OTP is <strong>123456</strong>. No SMS is sent.</p>'):
 '<label class="field">Mobile number (+91)<input name="phone" inputmode="numeric" autocomplete="tel-national" pattern="[0-9]{10}" maxlength="10" required></label>'+(live?'':'<p class="notice">Use 9000000017 to try the sample walk-in, or enter any fictional 10-digit number.</p>'))+
 '<p class="err" id="form-error" role="alert"></p><button class="primary" type="submit">'+(pendingPhone?"Verify & Continue":live?"Send OTP":"Get Demo OTP")+'</button>'+
 (pendingPhone?btn("Change Number","change-number","link"):"")+'</form>';
}
function profileFields(){
 const details=(live?profile:profile?.phone===phone?profile:null)??{};
 return '<label class="field">Name<input name="name" autocomplete="name" required maxlength="80" value="'+esc(details.name)+'"></label>'+
 '<label class="field">Age<input name="age" type="number" required min="0" max="120" value="'+esc(details.age)+'"></label>'+
 '<label class="field">Sex<select name="sex" required><option value="">Select</option>'+["Female","Male","Intersex","Prefer not to say"].map(s=>'<option '+(details.sex===s?"selected":"")+'>'+s+'</option>').join("")+'</select></label>'+
 (live?'<label class="field">Mobile number<input name="mobile" type="tel" autocomplete="tel" maxlength="24" '+(page==="details"?"required ":"")+'value="'+esc(details.mobile||(phone?"+91"+phone:""))+'"></label>'+
 '<label class="field">Email<input value="'+esc(user?.email)+'" readonly></label>':
 '<label class="field">Verified mobile number<input value="+91 '+esc(phone)+'" readonly></label>');
}
function details(){
 const session=sessionOptions()[selected.session];
 return pageTitle("Confirm Patient Details")+'<form class="panel raised stack" data-form="booking">'+profileFields()+
 '<div class="notice"><strong>'+esc(doctor().name)+'</strong><br>'+esc(facility().name)+' · '+prettyDay(selected.date)+'<br>'+session.name+' · '+sessionHours(session)+' · ₹'+doctor().fee+'</div>'+
 '<p class="err" id="form-error" role="alert"></p><button class="primary" type="submit">Confirm Booking</button></form>';
}
const tokenLabel=token=>"#"+String(token).padStart(2,"0");
function confirm(){
 const b=activeBooking;
 const {minutes}=waitEstimate(b);
 return pageTitle("Booking Confirmed")+'<div class="panel raised stack"><p>'+icon("check")+' Your Token</p><div class="number">'+tokenLabel(b.token)+'</div><h2>'+esc(b.doctor)+'</h2><p>'+esc(b.facilityName)+' · '+prettyDay(b.date)+'<br>'+b.sessionName+'</p>'+
 (minutes==null?'':'<p>Estimated consultation at <strong>'+formatTime(Date.now()+minutes*60000)+'</strong></p>')+
 btn("Track My Token","track:"+b.id)+'</div>';
}
function token(){
 const all=appointments().filter(active).sort((a,b)=>live
  ? Date.parse(a.starts_at)-Date.parse(b.starts_at)||a.token-b.token
  : a.date.localeCompare(b.date)||a.token-b.token);
 const b=all.find(item=>item.id===activeBooking?.id)??all[0];
 if(!b) return pageTitle("My Token")+(queueError?'<p role="alert" class="notice">'+esc(queueError)+'</p>':'')+'<div class="panel raised stack"><h2>No active token</h2><p>Open an active appointment to see your token.</p>'+btn("Find a Doctor","nav:home")+(live?(signedIn()?'':btn(loginLabel,"login:token","link")):btn("Try Walk-in Tracking","walkin:raj","link"))+'</div>';
 const nowServing=(live&&(b.opd_status!=="open"||!b.current_started_at))||!b.current?null:b.current;
 const {ahead,minutes}=waitEstimate(b);
 const status=b.opd_status==="paused"?"OPD paused · Timing update pending":
  b.opd_status==="late"?"Doctor running late"+(b.revised_start_at?" · Revised start "+formatTime(b.revised_start_at):""):
  b.opd_status==="scheduled"?"OPD yet to start · "+formatTime(b.starts_at):
  b.status==="serving"||(!live&&b.current>=b.token)?"Your turn now. Please report to reception.":
  live&&b.current>=b.token?"Please check with reception for your token status.":
  minutes!=null&&minutes<=5?"Your turn is near. Please be ready.":"";
 return pageTitle("My Token")+(all.length>1?'<label class="field">Select appointment<select id="active-booking">'+all.map(item=>'<option value="'+item.id+'" '+(item.id===b.id?"selected":"")+'>'+esc(item.doctor)+' · '+prettyDay(item.date)+' · '+esc(item.sessionName)+' · '+tokenLabel(item.token)+'</option>').join("")+'</select></label>':"")+
 '<section class="panel raised stack">'+(live?'':'<p class="tag">Demo queue</p>')+'<h2>'+esc(b.doctor)+'</h2><p>'+esc(b.facilityName)+' · '+prettyDay(b.date)+' · '+esc(b.sessionName)+' OPD</p>'+
 '<div class="numbers"><div class="stat"><p>Now Serving</p><div class="number">'+(nowServing==null?"—":tokenLabel(nowServing))+'</div></div><div class="stat"><p>Your Token</p><div class="number">'+tokenLabel(b.token)+'</div></div></div>'+
 (status?'<p><strong>'+status+'</strong></p>':'')+
 (minutes!=null&&b.status!=="serving"&&b.current<b.token?'<p><strong>'+ahead+'</strong> '+(ahead===1?'patient':'patients')+' ahead</p><p>Estimated wait <strong>'+minutes+' min</strong><br>Suggested arrival <strong>'+formatTime(Date.now()+Math.max(0,minutes-5)*60000)+'</strong></p>':'')+
 (live?(queueError?'<p role="alert" class="notice">'+esc(queueError)+'</p>':''):btn("Advance Demo Queue","advance:"+b.id,"link"))+'</section>';
}
function appointmentQueueStatus(b){
 if(b.opd_status==="paused")return "OPD paused";
 if(b.opd_status==="late")return "Doctor running late"+(b.revised_start_at?" · Revised start "+formatTime(b.revised_start_at):"");
 if(b.opd_status==="scheduled")return "OPD hasn’t started yet";
 if(b.status==="serving")return "Your turn now · 0 min wait";
 const {minutes}=waitEstimate(b);
 return minutes==null?"Waiting":"Estimated wait · "+minutes+" min";
}
function appointmentPage(){
 const list=appointments().filter(b=>historyTab==="cancelled"?b.status==="cancelled":historyTab==="upcoming"?active(b):!active(b)&&b.status!=="cancelled");
 return pageTitle("Appointments")+'<div class="chips">'+["upcoming","past","cancelled"].map(tab=>'<button class="chip" data-action="history:'+tab+'" aria-pressed="'+(historyTab===tab)+'">'+(tab==="upcoming"?"Upcoming":"Past")+'</button>').join("")+'</div>'+
 (accountError?'<p class="notice" role="alert">'+esc(accountError)+'</p>':'')+
 (list.length?list.map(b=>'<article class="panel raised stack"><h2>'+esc(b.doctor)+'</h2><p>'+esc(b.facilityName)+' · '+prettyDay(b.date)+' · '+b.sessionName+'</p><p class="tag">Token '+tokenLabel(b.token)+'</p>'+(
 active(b)?(live?'<p>'+esc(appointmentQueueStatus(b))+'</p>':'')+btn("Track Token","track:"+b.id)+
 (live&&b.source==="online"&&["scheduled","late"].includes(b.opd_status)?btn("Cancel appointment","cancel-booking:"+b.id,"link"):""):'<p>'+({completed:"Completed",no_show:"No Show",cancelled:"Cancelled"}[b.status]||"Session ended")+'</p>')+'</article>').join(""):'<div class="panel raised stack"><p>No '+historyTab+' appointments.</p>'+(!signedIn()&&live?btn(loginLabel,"login:appointments"):btn("Find a Doctor","nav:home"))+'</div>');
}
function account(){
 return pageTitle("Account")+(accountError?'<p role="alert" class="notice">'+esc(accountError)+'</p>':'')+(signedIn()?'<form class="panel raised stack" data-form="profile">'+profileFields()+'<p class="err" id="form-error" role="alert"></p><button class="primary" type="submit">Save Profile</button>'+btn("Sign Out","signout","link")+'</form>':
 '<div class="panel raised stack"><p>Sign in to manage your patient profile and bookings.</p>'+btn(loginLabel,"login:account")+'</div>')+
 joinProvider()+'<section class="panel raised stack" aria-label="Account resources">'+resourcePages.map(([id,label])=>btn(label,id,"chip")).join("")+'</section>';
}
function walkin(){
 const f=facilities.find(f=>f.id===walkInFacility);
 const found=walkins();
 return pageTitle("Walk-in Tracking")+'<div class="panel raised stack"><h2>'+esc(f?.name||"Facility")+'</h2>'+(f?btn("View Doctors &amp; Book","facility:"+f.id):'')+
 (live&&!walkInSms&&!phone?'<p>Walk-in tokens require a verified mobile number. Online bookings are available with email sign-in.</p>'+btn("Find a Doctor","nav:home"):found.length?found.map(b=>btn(esc(b.doctor)+" · "+tokenLabel(b.token),"track:"+b.id)).join(""):phone?
 '<p>No active walk-in appointment found for this number.</p>'+btn("Try Another Number","login:walkin"):
 '<p>Verify the mobile number you gave at reception to open your token.</p>'+btn("Verify Mobile Number","login:walkin"))+'</div>';
}
function supportPage(){
 return pageTitle("Contact support")+(signedIn()&&live?'<form class="panel raised stack" data-form="support">'+
 '<label class="field">Subject<input name="subject" required minlength="3" maxlength="120"></label>'+
 '<label class="field">Message<textarea name="message" required minlength="10" maxlength="2000" rows="5"></textarea></label>'+
 '<p id="form-error" role="alert" class="err"></p><button class="primary" type="submit">Send request</button></form>':
 '<div class="panel raised stack"><p>Sign in to send a support request.</p>'+btn(loginLabel,"login:support")+'</div>');
}
function locationPage(){
 return pageTitle("Change Location")+
 '<section class="panel raised stack">'+btn("Use Current Location","use-current-location")+
 '<p class="small">Uses your device coordinates to look up your locality via Photon (OpenStreetMap).</p>'+
 '<form class="stack" data-form="location"><label class="field">Search Location<input name="area" type="search" minlength="2" maxlength="100" placeholder="Search for a city or locality in India" required></label>'+
 '<button class="primary" type="submit">Search</button></form>'+
 '<p class="small" id="location-status" role="status"></p><div class="stack" id="location-results"></div></section>';
}
function selectLocation(place){
 locationName=place.name;
 discoveryCenter={latitude:place.latitude,longitude:place.longitude};
 save("location",locationName);
 save("location-center",discoveryCenter);
 externalFacilities=[];
 if(live)facilities=storedFacilities;
 query="";category="";
 go("home",true);
 refreshDiscovery();
}
let locationRequest=0;
async function lookupLocation(query){
 const status=screen.querySelector("#location-status");
 const results=screen.querySelector("#location-results");
 const request=++locationRequest;
 const isCurrent=()=>page==="location"&&status.isConnected&&request===locationRequest;
 results.replaceChildren();
 status.textContent=query?"Searching locations…":"Detecting your locality…";
 try{
  if(!query){
   const place=await currentLocality();
   if(isCurrent())selectLocation(place);
   return;
  }
  const matches=await searchLocations(query);
  if(!isCurrent())return;
  status.textContent=matches.length?"Choose a location.":"No locations found.";
  for(const place of matches){
   const {name,context}=place;
   const button=document.createElement("button");
   button.type="button";
   button.className="chip";
   button.textContent=context?name+" · "+context:name;
   button.addEventListener("click",()=>selectLocation(place));
   results.append(button);
  }
 }catch(error){
  if(isCurrent())status.textContent=query?"Location search failed. Try again.":error.message;
 }
}
function render(){
 shell();
 const pages={home,support:supportPage,facility:detail,schedule,login,details,confirm,token,appointments:appointmentPage,account,walkin,help,privacy,refund,about,experts,expertAnswer,
 location:locationPage,
 notifications:()=>pageTitle("Notifications")+'<p class="panel raised">No new notifications.</p>',
 specialties:()=>pageTitle("Specialties")+'<div class="panel raised stack">'+["General","Physician","Dentist","Gynae","Surgery"].map(s=>btn(s,"filter:"+s,"chip")).join("")+'</div>'};
 screen.innerHTML=pages[page]().replaceAll(/<div class="photo"><img /g,'<div><img class="photo" ');
 if(page==="home")connectHomeBanners();
}
document.addEventListener("click",async event=>{
 const control=event.target.closest("[data-action]");
 if(!control||busy)return;
 const [action,value]=control.dataset.action.split(":");
 switch(action){
 case "back":page=previous.pop()??"home";render();scrollTo(0,0);break;
 case "nav":go(value,true);break;
 case "support":case "help":case "privacy":case "refund":case "about":case "experts":go(action);break;
 case "expert-topic":{
  const topics=[...new Set(reviewedAnswers.map(item=>item.topic))].sort();
  expertTopic=["",...topics][Number(value)]??"";
  render();
  screen.querySelector('[data-action="expert-topic:'+Number(value)+'"]')?.focus();
  break;
 }
 case "expert-answer":
  expertAnswerIndex=Number(value);
  if(reviewedAnswers[expertAnswerIndex])go("expertAnswer");
  break;
 case "use-current-location":await lookupLocation();break;
 case "location":case "notifications":case "specialties":go(action);break;
 case "open-filter":openOnly=!openOnly;render();break;
 case "clear":openOnly=false;radius=0;category="";query="";render();document.getElementById("search").focus();break;
 case "filter":category=value;query="";go("home",true);document.getElementById("results").scrollIntoView({block:"center"});break;
 case "facility":selected={facility:value};department="";facilitySessions=null;go("facility");if(live&&canBook(facility()))void refreshFacilitySessions(facility());break;
 case "cancel-booking":
  if(live&&confirm("Cancel this appointment?")){
   try{await backend.cancel(value);await refreshAppointments();historyTab="cancelled";render();}
   catch(error){accountError=error.message||"Could not cancel the appointment.";render();}
  }
  break;
 case "book":if(!canBook(facility()))break;selected={facility:selected.facility,doctor:Number(value),date:dayKey()};await openSchedule();break;
 case "retry-schedule":await openSchedule();break;
 case "retry-catalog":await loadCatalog();render();refreshDiscovery();break;
 case "date":selected.date=value;selected.session=null;render();break;
 case "session":selected.session=Number(value);render();break;
 case "continue":
  if(!available(sessionOptions()[selected.session])){render();break;}
  signedIn()?go("details"):startLogin("details");break;
 case "login":startLogin(value);break;
 case "change-number":pendingPhone="";render();break;
 case "history":historyTab=value;render();break;
 case "track":activeBooking=appointments().find(b=>b.id===value);go("token");break;
 case "advance":{
  if(live)break;
  const b=appointments().find(item=>item.id===value);
  if(b&&b.current<b.token){b.current++;save("bookings",bookings);render();}
  break;
 }
 case "walkin":walkInFacility=value;go("walkin");break;
 case "signout":
  if(live){
   try{await backend.signOut();clearAccount();}catch{document.getElementById("form-error").textContent="Sign out failed. Try again.";break;}
  }else{phone="";activeBooking=null;save("phone",phone);}
  render();break;
 }
});
function startLogin(returnPage){authReturn=returnPage;pendingPhone="";go("login");}
document.addEventListener("input",event=>{
 if(event.target.id==="search"){query=event.target.value;document.getElementById("results").innerHTML=results();}
});
document.addEventListener("change",event=>{
 if(event.target.id==="distance-filter"){radius=Number(event.target.value);document.getElementById("results").innerHTML=results();}
 if(event.target.id==="sort-directory"){sortBy=event.target.value;document.getElementById("results").innerHTML=results();}
 if(event.target.id==="facility-department"){department=event.target.value;render();}
 if(event.target.id==="active-booking"){activeBooking=appointments().find(b=>b.id===event.target.value);render();}
});
document.addEventListener("submit",async event=>{
 const type=event.target.dataset.form;
 if(!type)return;
 event.preventDefault();
 if(busy)return;
 const data=Object.fromEntries(new FormData(event.target));
 if(type==="location"){
  const area=data.area.trim();
  if(area.length>=2)await lookupLocation(area);
  else screen.querySelector("#location-status").textContent="Enter at least two characters.";
  return;
 }
 if(live){await submitLive(type,data,event.target,event.submitter?.value);return;}
 if(type==="otp"){
  if(!pendingPhone){pendingPhone=data.phone;render();screen.querySelector("[name=otp]").focus();return;}
  if(data.otp!=="123456"){document.getElementById("form-error").textContent="Enter the demo code 123456.";return;}
  phone=pendingPhone;pendingPhone="";save("phone",phone);
  if(authReturn==="walkin"&&phone==="9000000017"&&walkInFacility==="raj"&&!bookings.some(b=>b.id==="demo-walkin")){
   bookings.push({id:"demo-walkin",source:"walkin",phone,facility:"raj",facilityName:"Raj Clinic",doctor:"Dr. Rahul Sharma",sessionName:"Evening",date:dayKey(),token:17,current:12});
   save("bookings",bookings);
  }
  const found=appointments().filter(b=>b.facility===walkInFacility&&b.source==="walkin");
  if(authReturn==="walkin"&&found.length===1){activeBooking=found[0];go("token",true);return;}
  go(authReturn);return;
 }
 if(!phone||!data.name.trim())return;
 if(type==="booking"&&appointments().some(b=>b.facility===facility().id&&b.doctor===doctor().name&&b.date===selected.date&&b.sessionName===demoSessions[selected.session].name)){
  document.getElementById("form-error").textContent="You already have this session booked. Open Appointments to track it.";return;
 }
 profile={name:data.name.trim(),age:data.age,sex:data.sex,phone};save("profile",profile);
 if(type==="profile"){go("account",true);screen.querySelector("form").insertAdjacentHTML("beforeend",'<p role="status" class="notice">Profile saved.</p>');return;}
 const existing=bookings.filter(b=>b.facility===facility().id&&b.doctor===doctor().name&&b.date===selected.date&&b.sessionName===demoSessions[selected.session].name);
 const last=existing[existing.length-1];
 activeBooking={id:String(Date.now()),phone,source:"online",facility:facility().id,facilityName:facility().name,doctor:doctor().name,sessionName:demoSessions[selected.session].name,date:selected.date,token:(last?.token??16)+1,current:last?.current??12};
 bookings.push(activeBooking);save("bookings",bookings);go("confirm");
});
function clearAccount(){
 user=null;phone="";profile=null;bookings=[];activeBooking=null;accountError="";queueError="";
}
async function loadCatalog(){
 try{
  const rows=await backend.facilities();
  directoryAliases=rows.filter(f=>f.merged_into);
  storedFacilities=rows.filter(f=>!f.is_demo&&!f.merged_into).map(f=>({...f,img:f.type.toLowerCase()}));
  facilities=combineDirectory(storedFacilities,externalFacilities);
  catalogError="";
 }catch{catalogError="Could not load clinics and hospitals. Please try again.";}
}
async function refreshAppointments(){
 const owner=user?.id;
 if(!owner)return;
 const rows=await backend.appointments();
 if(user?.id!==owner)return;
 bookings=rows.map(b=>({...b,date:dateKey(b.starts_at),facilityName:b.facility_name,sessionName:b.session_name,current:b.current_token}));
}
async function setAccount(nextUser){
 const number=nextUser?.phone?.replace(/^\+?91(?=\d{10}$)/,"");
 if(!nextUser){clearAccount();return;}
 if(user?.id!==nextUser.id)clearAccount();
 user=nextUser;phone=nextUser.phone_confirmed_at&&/^\d{10}$/.test(number??"")?number:"";
 const [details]=await Promise.all([backend.profile(),refreshAppointments()]);
 if(user?.id===nextUser.id){profile=details?{...details,phone}:null;accountError="";}
}
async function submitLive(type,details,form,action){
 busy=true;
 const button=form.querySelector("button[type=submit]");
 button.disabled=true;
 const error=form.querySelector("#form-error");
 error.textContent="";
 try{
  if(type==="otp"&&walkInSms&&authReturn==="walkin"){
   if(!pendingPhone){
    if(!/^\d{10}$/.test(details.phone))throw new Error("Enter a 10-digit mobile number.");
    await backend.sendWalkInCode("+91"+details.phone,Boolean(user));
    pendingPhone=details.phone;
    render();
    screen.querySelector("[name=otp]").focus();
    return;
   }
   await backend.verifyWalkInCode("+91"+pendingPhone,details.otp,Boolean(user));
   await setAccount(await backend.currentUser());
   pendingPhone="";
   const found=walkins();
   if(found.length===1){activeBooking=found[0];go("token",true);}
   else go("walkin",true);
   return;
  }
  if(type==="email-login"){
   const status=form.querySelector("#form-status");
   status.textContent="";
   const email=details.email.trim();
   if(action==="signup"&&details.password.length<8){
    error.textContent="Use at least 8 characters for your password.";
    return;
   }
   const result=action==="signup"
    ?await backend.signUp(email,details.password)
    :await backend.signIn(email,details.password);
   if(!result.session){
    status.textContent="Check your email to confirm your account, then return here to sign in.";
    return;
   }
   await setAccount(result.user);
   go(authReturn,true);
   return;
  }
  if(!user){startLogin(type==="support"?"support":type==="booking"?"details":"account");return;}
  if(type==="support"){
   await backend.support(details.subject.trim(),details.message.trim());
   form.reset();
   const sent=document.createElement("p");
   sent.setAttribute("role","status");sent.textContent="Support request sent.";
   form.append(sent);
   return;
  }
  const fields={name:details.name.trim(),age:Number(details.age),sex:details.sex,mobile:details.mobile?.trim()||null};
  if(fields.mobile){
   let number=fields.mobile.replace(/[ .()-]/g,"");
   if(/^\d{10}$/.test(number)) number="+91"+number;
   if(!/^\+[1-9]\d{9,14}$/.test(number)){error.textContent="Enter a valid mobile number.";return;}
   fields.mobile=number;
  }
  if(!fields.name){error.textContent="Enter your name.";return;}
  if(type==="profile"){
   await backend.saveProfile(user.id,fields);
   profile={...fields,phone};
   form.insertAdjacentHTML("beforeend",'<p role="status" class="notice">Profile saved.</p>');
   return;
  }
  const session=sessionOptions()[selected.session];
  if(!available(session)){
   error.textContent="That OPD session is no longer available. Go back and choose another session.";
   return;
  }
  const id=await backend.book(session.id,fields);
  profile={...fields,phone};
  try{await refreshAppointments();}catch{
   accountError="Your booking was saved. Reopen Appointments to load your token.";
   go("appointments",true);
   return;
  }
  activeBooking=appointments().find(b=>b.id===id);
  if(activeBooking)go("confirm",true);else go("appointments",true);
 }catch(err){
  error.textContent=err.message||"Could not complete this request. Please try again.";
 }finally{
  busy=false;
  button.disabled=false;
 }
}
async function start(){
 if(live){
  screen.innerHTML='<p class="panel raised" role="status">Loading BANR…</p>';
  await Promise.all([loadCatalog(),backend.content("patient").then(value=>{
   content=contentWithDefaults(patientDefaults,value);
   loadReviewedAnswers();
  }).catch(()=>{}),(async()=>{
   try{await setAccount(await backend.currentUser());}
   catch{accountError="Could not load your account. Sign in again if needed.";}
  })()]);
  backend.authChanges(event=>{
   if(event==="SIGNED_OUT"){
    clearAccount();
    if(["confirm","details"].includes(page))go("account",true);else render();
   }
  });
  let refreshingFacility=false;
  setInterval(async()=>{
   if(page!=="facility"||refreshingFacility||!canBook(facility()))return;
   refreshingFacility=true;
   try{await refreshFacilitySessions(facility());}
   finally{refreshingFacility=false;}
  },15000);
  let refreshing=false;
  setInterval(async()=>{
   if(!user||refreshing||!["token","appointments","walkin"].includes(page)||busy)return;
   refreshing=true;
   try{await refreshAppointments();queueError="";accountError="";}
   catch{queueError="Could not refresh the queue. Showing the last update.";}
   finally{refreshing=false;if(["token","appointments","walkin"].includes(page)&&!busy)render();}
  },5000);
 }
 const incoming=urlParams.get("listing")||walkInFacility;
 const alias=directoryAliases.find(f=>f.id===incoming);
 const listing=facilities.find(f=>(f.directory_only||alias||urlParams.has("listing"))&&f.id===(alias?.merged_into||incoming));
 if(listing){selected={facility:listing.id};page="facility";}
 else if((live&&/^[a-z0-9-]+$/.test(walkInFacility??""))||facilities.some(f=>f.id===walkInFacility)){
  page="walkin";
  const found=walkins();
  if(found.length===1){activeBooking=found[0];page="token";}
 }
 render();
 if(live)refreshDiscovery();
}
start();
