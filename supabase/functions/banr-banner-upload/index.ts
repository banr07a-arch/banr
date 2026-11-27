import { createClient } from "npm:@supabase/supabase-js@2.119.2";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-banr-admin-session", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const reply = (body: unknown, status=200) => Response.json(body,{status,headers:cors});
const max = 5*1024*1024;
function typeOf(bytes:Uint8Array) {
  if ([137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)) return ["image/png","png"];
  if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return ["image/jpeg","jpg"];
  const part=(start:number,end:number)=>String.fromCharCode(...bytes.slice(start,end));
  if (part(0,4)==="RIFF" && part(8,12)==="WEBP") return ["image/webp","webp"];
  return [];
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS") return new Response(null,{headers:cors});
  if(req.method!=="POST") return reply({error:"Use POST."},405);
  const token=req.headers.get("x-banr-admin-session");
  if(!token || !/^[a-f0-9]{64}$/.test(token)) return reply({error:"Sign in to Super Admin again."},401);
  const auth=await db.rpc("banr_banner_upload_authorized",{p_token:token});
  if(auth.error || auth.data!==true) return reply({error:"Sign in to Super Admin again."},401);
  if (Number(req.headers.get("content-length"))>max+65536) return reply({error:"Choose an image up to 5 MB."},413);
  try {
    const file=(await req.formData()).get("image");
    if(!(file instanceof File)||file.size===0) return reply({error:"Choose an image file."},400);
    if(file.size>max) return reply({error:"Choose an image up to 5 MB."},413);
    const [mime,extension]=typeOf(new Uint8Array(await file.slice(0,12).arrayBuffer()));
    if(!mime || file.type!==mime) return reply({error:"Use a PNG, JPG or WebP image."},415);
    const path=crypto.randomUUID()+"."+extension;
    const bucket=db.storage.from("banr-banner-assets");
    const result=await bucket.upload(path,file,{contentType:mime,cacheControl:"31536000"});
    if(result.error) return reply({error:"Upload failed. Try again."},502);
    return reply({url:bucket.getPublicUrl(path).data.publicUrl});
  } catch {
    return reply({error:"Could not read the image upload."},400);
  }
});