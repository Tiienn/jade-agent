// Offline checks for the server-side source fetch: no accounts, no sandbox, no
// Microsoft. Unlike cloud-smoke.mjs this costs nothing to run.
//   node scripts/lease_plans/fetch-source-test.mjs
import assert from 'node:assert/strict'
import { fetchSource } from '../../server/lease/cloud.mjs'

process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
process.env.VITE_SUPABASE_ANON_KEY = 'anon'
const dwg = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(10)])
const job = (source) => ({id:'j', user_id:'u', kind:'generate', request:{source}})
const good = {id:'item1', driveId:'drive1', name:'Palm Square F18 Lease.dwg'}

function stub({ok=true,status=200,name=good.name,length=dwg.length,body=dwg,disposition=true}={}) {
  const headers = new Map([['content-length',String(length)]])
  if (disposition) headers.set('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  globalThis.fetch = async () => ({ok,status,headers:{get:k=>headers.get(k)??null},arrayBuffer:async()=>body})
}
async function rejects(label, fn, match) {
  await assert.rejects(fn, e => { assert.match(e.message, match, `${label}: got "${e.message}"`); return true })
  console.log('PASS', label)
}

stub()
assert.deepEqual(await fetchSource(job(good), 'tok'), dwg)
console.log('PASS happy path returns the fetched bytes')

await rejects('missing SharePoint location', () => fetchSource(job({name:good.name}), 'tok'), /missing its SharePoint location/)

stub({ok:false,status:403})
await rejects('upstream refusal is reported without its body', () => fetchSource(job(good), 'tok'), /^Could not read the source drawing from SharePoint \(403\)\./)

stub({length: 25*1024*1024})
await rejects('declared length over the ceiling', () => fetchSource(job(good), 'tok'), /up to 24 MB/)

stub({name:'Palm Square F18 Lease (superseded).dwg'})
await rejects('renamed in SharePoint since the request', () => fetchSource(job(good), 'tok'), /is now called "Palm Square F18 Lease \(superseded\)\.dwg"/)

// No Content-Disposition: nothing is claimed about the name, bytes still used.
stub({disposition:false})
assert.deepEqual(await fetchSource(job(good), 'tok'), dwg)
console.log('PASS missing disposition header does not block the fetch')

// A name needing percent-decoding must compare equal, not trip the mismatch.
stub({name:'Raffles Tower 1 — 1H Lease.dwg'})
assert.deepEqual(await fetchSource(job({...good, name:'Raffles Tower 1 — 1H Lease.dwg'}), 'tok'), dwg)
console.log('PASS encoded name round-trips to an exact match')
