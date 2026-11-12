import { createClient } from '@supabase/supabase-js'
import { waitUntil } from '@vercel/functions'
import { fetchSource, runJob, bucket, key, checked } from '../server/lease/cloud.mjs'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const options = {auth:{persistSession:false,autoRefreshToken:false}}
const fail = (status,message) => Object.assign(new Error(message),{status})
export default async function handler(req,res) {
 res.setHeader('Cache-Control','no-store')
 try {
  const db = createClient(process.env.VITE_SUPABASE_URL,process.env.LEASE_SERVICE_ROLE_KEY,options)
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
  if (!bearer) throw fail(401,'Sign in to Jade Agent.')
  const auth = await db.auth.getUser(bearer)
  if (auth.error || !auth.data.user) throw fail(401,'Your session expired. Sign in again.')
  const uid = auth.data.user.id
  const profile = checked(await db.from('profiles').select('active').eq('id',uid).maybeSingle())
  if (!profile?.active) throw fail(403,'This account is inactive.')
  const action = new URL(req.url,'http://localhost').searchParams.get('action') || 'list'
  const body = req.body || {}
  if (JSON.stringify(body).length>65536) throw fail(413,'The edit request is too large.')
  // A terminated job cannot hold the account's single processing slot forever.
  checked(await db.from('lease_jobs').update({status:'failed',error:'The cloud job expired. Please prepare a new review.',updated_at:new Date().toISOString()}).eq('user_id',uid).in('status',['uploading','processing']).lt('updated_at',new Date(Date.now()-600000).toISOString()))
  if (action==='list' && req.method==='GET') {
   const jobs=checked(await db.from('lease_jobs').select('id,kind,status,review,error,created_at,published_at,published').eq('user_id',uid).order('created_at',{ascending:false}).limit(100))
   return res.status(200).json({jobs})
  }
  // The shared library. A finished plan is a company record, so every active
  // member of staff can find and read one; drafts, failures and in-flight jobs
  // stay with their owner. user_id is resolved to a display name and dropped
  // rather than returned, so the page never handles other people's account ids.
  if (action==='library' && req.method==='GET') {
   const plans=checked(await db.from('lease_jobs').select('id,user_id,kind,review,created_at,published_at,published').eq('status','ready').order('created_at',{ascending:false}).limit(100))
   const owners=[...new Set(plans.map(plan=>plan.user_id))]
   const people=owners.length?checked(await db.from('profiles').select('id,display_name').in('id',owners)):[]
   const names=Object.fromEntries(people.map(person=>[person.id,person.display_name]))
   return res.status(200).json({plans:plans.map(({user_id,...plan})=>({...plan,preparedBy:names[user_id]||'Former staff',mine:user_id===uid}))})
  }
  if (req.method!=='POST') throw fail(405,'Use POST for this action.')
  if (!uuid.test(body.id || '')) throw fail(400,'Invalid review identifier.')
  if (action==='create') {
   const old=checked(await db.from('lease_jobs').select('*').eq('id',body.id).eq('user_id',uid).maybeSingle())
   if (old) return res.status(200).json({job:old})
   const recent=await db.from('lease_jobs').select('id',{count:'exact',head:true}).eq('user_id',uid).gte('created_at',new Date(Date.now()-86400000).toISOString())
   checked(recent)
   if (recent.count>=60) throw fail(429,'Daily pilot limit reached (60 reviews). Try again tomorrow.')
   const kind=body.kind
   if (!['generate','edit'].includes(kind)) throw fail(400,'Invalid operation.')
   let request
   if (kind==='generate') {
    const {tenant,date,source,project,unit}=body
    if (typeof project !== 'string' || !project.trim() || project.length > 100 || /[\x00-\x1f/\\<>:"|?*]/.test(project)) throw fail(422,'Choose a valid project.')
    if (typeof unit !== 'string' || !/^[A-Z0-9][A-Z0-9 ()._-]{0,19}$/.test(unit)) throw fail(422,'Enter a valid unit number.')
    if (typeof tenant!=='string'||!tenant.trim()||tenant.length>70||/[\x00-\x1f/\\<>:"|?*{}%]/.test(tenant)) throw fail(422,'Enter a tenant name of 1–70 plain characters.')
    if (typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||date<'2000-01-01'||date>'2100-12-31'||new Date(date).toISOString().slice(0,10)!==date) throw fail(422,'Choose a valid drawing date.')
    const escapedUnit=unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const unitPattern=new RegExp('(?<![A-Za-z0-9])'+escapedUnit+'(?![A-Za-z0-9]|-[A-Za-z0-9]|[.][0-9])','i')
    if (!source||typeof source.name!=='string'||!source.name.toLowerCase().endsWith('.dwg')||!unitPattern.test(source.name)||source.size>24*1024*1024) throw fail(422,'Choose a DWG matching this unit, up to 24 MB.')
    // The server fetches the drawing by these two, so a request without them
    // cannot be run. Refuse it here rather than accept a job that must fail.
    if (typeof source.id!=='string'||!source.id||typeof source.driveId!=='string'||!source.driveId) throw fail(422,'This drawing is missing its SharePoint location. Locate it again.')
    request={tenant:tenant.trim(),date,source:Object.fromEntries(['id','driveId','name','path','size','lastModified'].filter(k=>source[k]!==undefined).map(k=>[k,source[k]])),project,unit}
   } else {
    const {reviewId,sourceSha256,outline,notes}=body
    if (!uuid.test(reviewId||'')||typeof sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(sourceSha256)||!outline||!Array.isArray(notes)) throw fail(422,'Invalid edits. Reopen the editor.')
    const parent=checked(await db.from('lease_jobs').select('id').eq('id',reviewId).eq('user_id',uid).eq('status','ready').maybeSingle())
    if (!parent) throw fail(404,'Review not found.')
    request={reviewId,sourceSha256,outline,notes}
   }
   const result=await db.from('lease_jobs').insert({id:body.id,user_id:uid,kind,status:'processing',request}).select().single()
   if (result.error?.code==='23505') throw fail(409,'A lease plan is already processing. Check your recent jobs.')
   const job=checked(result)
   // Accepted. The drawing is fetched from SharePoint and processed after this
   // response, so closing the browser does not stop it. `bearer` is used only
   // for that fetch, as the caller, and is never stored.
   waitUntil(runJob(db,job,kind==='generate'?{source:()=>fetchSource(job,bearer)}:{}))
   return res.status(202).json({job})
  }
  const job=checked(await db.from('lease_jobs').select('*').eq('id',body.id).maybeSingle())
  if (!job) throw fail(404,'Review not found.')
  // Reading a finished plan no longer requires owning it. A job that is not
  // ready stays invisible to everyone else, including the fact that it exists.
  if (job.user_id!==uid && !(action==='file' && job.status==='ready')) throw fail(404,'Review not found.')
  if (action==='file') {
   if(job.status!=='ready'||!['pdf','dwg','editor'].includes(body.kind)) throw fail(404,'Review file not available.')
   // Colleagues read the finished DWG and PDF. The editor scene is not a
   // document, it is the start of an edit, and `create` refuses an edit of
   // someone else's plan -- so refuse it here too rather than open an editor
   // that cannot save.
   if(body.kind==='editor'&&job.user_id!==uid) throw fail(403,'Only the person who prepared this plan can edit it.')
   const file=body.kind==='editor'?'editor.json':`result.${body.kind}`
   const signed=checked(await db.storage.from(bucket).createSignedUrl(key(job,file),120))
   return res.status(200).json({url:signed.signedUrl})
  }
  throw fail(404,'Unknown lease action.')
 } catch(error) {
  res.status(error.status||500).json({error:error.status?error.message:'Lease processing is temporarily unavailable. Please try again.'})
 }
}
