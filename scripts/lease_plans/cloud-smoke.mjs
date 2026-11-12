// Explicit live integration test: temporary staff accounts, private storage, real Linux CAD.
import {createClient} from '@supabase/supabase-js'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {runJob,checked,bucket,key} from '../../server/lease/cloud.mjs'
const ref='nfnpwkkcafaumxrqjdai'
const keys=JSON.parse(execFileSync('supabase',['projects','api-keys','--project-ref',ref,'-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))
const url=`https://${ref}.supabase.co`,anon=keys.find(k=>k.name==='anon').api_key,service=keys.find(k=>k.name==='service_role').api_key
const opts={auth:{persistSession:false,autoRefreshToken:false}}
const db=createClient(url,service,opts),users=[],jobs=[]
const credentials={token:JSON.parse(readFileSync('/Users/tien/Library/Application Support/com.vercel.cli/auth.json')).token,projectId:'prj_8er7VSiSLKBZFbWkJT6fwEHIaTy0',teamId:'team_SPWfalw3FIQ3NTuZroXwYnUj'}
try {
 const clients=[]
 for(let i=0;i<2;i++){
  const name='lease-smoke-'+crypto.randomUUID(),email=name+'@workers.jadegroup.app',password=crypto.randomUUID()+'Aa1!'
  const {user}=checked(await db.auth.admin.createUser({email,password,email_confirm:true}));users.push(user.id)
  checked(await db.from('profiles').insert({id:user.id,username:name,display_name:'Lease validation',role:'worker',active:true}))
  const client=createClient(url,anon,opts);checked(await client.auth.signInWithPassword({email,password}));clients.push(client)
 }
 let job={id:crypto.randomUUID(),user_id:users[0],kind:'generate',status:'processing',request:{project:'Palm Square',unit:'F18',tenant:'Dr. Antoine Leuteritz',date:'2026-10-14',source:{name:'F18.dwg'}}}
 jobs.push(job)
 checked(await db.from('lease_jobs').insert(job))
 const source=readFileSync(process.env.STUDIO_TEST_DWG)
 await runJob(db,job,{credentials,source})
 job=checked(await db.from('lease_jobs').select('*').eq('id',job.id).single())
 assert.equal(job.status,'ready',job.error)
 console.log('PASS real Linux cloud generation, validated DWG/PDF')
 assert.equal(checked(await clients[1].from('lease_jobs').select('id')).length,0)
 assert.equal(checked(await clients[0].from('lease_jobs').select('id')).length,1)
 assert((await clients[0].from('lease_jobs').update({status:'ready'}).eq('id',job.id)).error)
 assert((await clients[1].storage.from(bucket).download(key(job,'result.dwg'))).error)
 assert((await clients[0].storage.from(bucket).upload(key(job,'result.pdf'),Buffer.from('fake'))).error)
 const plan=JSON.parse(await checked(await db.storage.from(bucket).download(key(job,'editor.json'))).text())
 const edit={id:crypto.randomUUID(),user_id:users[0],kind:'edit',status:'processing',request:{reviewId:job.id,sourceSha256:plan.sourceSha256,outline:{...plan.outline,color:'Blue'},notes:[{text:'Proposed entrance',x:plan.outline.vertices[0][0]+100,y:plan.outline.vertices[0][1]+100,height:900}]}}
 jobs.push(edit);checked(await db.from('lease_jobs').insert(edit));await runJob(db,edit,{credentials})
 const edited=checked(await db.from('lease_jobs').select('*').eq('id',edit.id).single())
 assert.equal(edited.status,'ready',edited.error)
 const view=JSON.parse(await checked(await db.storage.from(bucket).download(key(edit,'editor.json'))).text())
 assert.equal(view.outline.color,'Blue');assert.equal(view.notes[0].text,'Proposed entrance')
 console.log('PASS saved blue highlight and text, reopened exact DWG, private owner boundaries')
 checked(await db.from('profiles').update({active:false}).eq('id',users[0]))
 assert.equal(checked(await clients[0].from('lease_jobs').select('id')).length,0)
 console.log('PASS disabled account cannot read reviews')
} finally {
 for(const job of jobs) await db.storage.from(bucket).remove(['result.dwg','result.pdf','editor.json'].map(file=>key(job,file)))
 for(const id of users) await db.auth.admin.deleteUser(id)
}
