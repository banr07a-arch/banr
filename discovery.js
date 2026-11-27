const osmAttribution = "https://www.openstreetmap.org/copyright";
const overpass = import.meta.env.VITE_DISCOVERY_OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const cache = new Map();
export const attribution = osmAttribution;

export function distanceKm(from, to) {
  if (!from || to.latitude == null || to.longitude == null) return Infinity;
  const radians = x => x * Math.PI / 180;
  const lat = radians(to.latitude - from.latitude);
  const lon = radians(to.longitude - from.longitude);
  const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(from.latitude)) *
    Math.cos(radians(to.latitude)) * Math.sin(lon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}

const weekdays = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
export function openingStatus(hours, now = new Date()) {
  if (hours === "24/7") return true;
  if (!hours) return null;
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "short", hour:"2-digit", minute:"2-digit", hourCycle:"h23",
  }).formatToParts(now);
  const get = type => local.find(part => part.type === type).value;
  const day = weekdays.indexOf(get("weekday").slice(0,2));
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  const match = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(off|\d\d:\d\d-\d\d:\d\d(?:,\d\d:\d\d-\d\d:\d\d)*)$/;
  let active = false;
  for (const entry of hours.split(";")) {
    const parts = match.exec(entry.trim());
    if (!parts) return null;
    const days = parts[1]?.split(",").flatMap(range => {
      const [start,end=start] = range.split("-").map(value=>weekdays.indexOf(value));
      return Array.from({length:(end-start+7)%7+1},(_,i)=>(start+i)%7);
    }) ?? weekdays.map((_,index)=>index);
    if (parts[2] === "off") {
      if (days.includes(day)) active = false;
      continue;
    }
    for (const period of parts[2].split(",")) {
      const [start,end] = period.split("-").map(time=>{
        const [h,m]=time.split(":").map(Number);
        return h<=24 && m<60 && (h<24 || m===0) ? h*60+m : NaN;
      });
      if (!Number.isFinite(start)||!Number.isFinite(end)||start===end) return null;
      if (end>start && days.includes(day) && minute>=start && minute<end) active=true;
      if (end<start && ((days.includes(day)&&minute>=start)||(days.includes((day+6)%7)&&minute<end))) active=true;
    }
  }
  return active;
}

function normalize(element, locality) {
  const t=element.tags ?? {};
  const title=(t["name:en"] || t.name || "").trim();
  const lat=element.lat ?? element.center?.lat;
  const lng=element.lon ?? element.center?.lon;
  if (!title || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const type=(t.amenity || t.healthcare)==="hospital"?"Hospital":"Clinic";
  const id="osm-"+element.type+"-"+element.id;
  return {
    id,name:title,type,img:type.toLowerCase(),area:t["addr:suburb"]||t["addr:city"]||locality,
    address:t["addr:full"] || [t["addr:housenumber"],t["addr:street"],t["addr:suburb"],t["addr:city"],t["addr:postcode"]].filter(Boolean).join(", "),
    latitude:lat,longitude:lng, hours:t.opening_hours||"",structuredHours:t.opening_hours,
    contact:t["contact:phone"]||t.phone, website:t["contact:website"]||t.website,
    specialties:(t["healthcare:speciality"]||"").replaceAll(";",", ").replaceAll("_"," "),
    directory_only:true,external:true,external_place_id:"osm:"+element.type+"/"+element.id,
    source_url:"https://www.openstreetmap.org/"+element.type+"/"+element.id,doctors:[],
  };
}

export async function nearbyDirectory(center, locality, signal) {
  const lat=Number(center.latitude), lng=Number(center.longitude);
  if (!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) return [];
  const roundedLat=lat.toFixed(2), roundedLng=lng.toFixed(2);
  const key=roundedLat+","+roundedLng;
  const cached=cache.get(key);
  if (cached && cached.expires>Date.now()) return cached.rows;
  const near="(around:5500,"+key+")";
  const query='[out:json][timeout:14];(nwr["amenity"~"^(hospital|clinic)$"]["name"]'+near+
    ';nwr["healthcare"~"^(hospital|clinic)$"]["name"]'+near+';);out center 160;';
  const response=await fetch(overpass,{
    method:"POST",body:new URLSearchParams({data:query}),
    signal:AbortSignal.any([signal,AbortSignal.timeout(18000)])
  });
  if(!response.ok)throw new Error("Nearby directory is temporarily unavailable.");
  const {elements}=await response.json();
  if(!Array.isArray(elements))throw new Error("Nearby directory is temporarily unavailable.");
  const found=new Map();
  for(const item of elements){
    if(!["node","way","relation"].includes(item.type)||!Number.isInteger(item.id))continue;
    const row=normalize(item,locality);
    if(row)found.set(row.id,row);
  }
  const rows=[...found.values()];
  cache.set(key,{rows,expires:Date.now()+15*60*1000});
  return rows;
}

const normalized = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
export function combineDirectory(verified, external) {
  const combined=[...verified];
  for(const row of external){
    if(combined.some(other=>other.external_place_id===row.external_place_id || (
      normalized(other.name)===normalized(row.name) && (
        distanceKm(row,other)<.3 || (row.address && normalized(other.address||"")===normalized(row.address))
      )
    )))continue;
    combined.push(row);
  }
  return combined;
}
