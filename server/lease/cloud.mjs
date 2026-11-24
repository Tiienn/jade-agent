import { Sandbox } from '@vercel/sandbox'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const engine = '/tmp/cad/cadcraft-0.7.0-linux-x86_64/bin/cadcraft-cli'
// Fixed, checksummed upstream binary. No user-controlled commands or download URLs.
const install = 'curl -fsSL --max-time 45 https://github.com/storytold/cadcraft/releases/download/v0.7.0/cadcraft-0.7.0-linux-x86_64.tar.gz -o /tmp/cad.tar.gz && echo "cf8d4aa86d046f34eb770ae6cd2df3eee17d1f3b129257f1558543046c955cc0  /tmp/cad.tar.gz" | sha256sum -c - && mkdir /tmp/cad && tar -xzf /tmp/cad.tar.gz -C /tmp/cad && mkdir -p /tmp/cadhome/.local/share/fonts'
const sourceLimit = 24 * 1024 * 1024
// The drawings' text styles ask for Arial Narrow by its Windows file names, and
// CADCraft looks fonts up by name in ~/.local/share/fonts among others. Without
// them it draws that text in its much wider stroke font, which reads as
// oversized lettering. Liberation Sans Narrow has Arial Narrow's widths; see
// server/lease/fonts/README.md. Lower-case names too: Linux file names are
// case-sensitive and drawings are not consistent about it.
const fontHome = '/tmp/cadhome'
const fontFiles = [['ARIALN.TTF','LiberationSansNarrow-Regular.ttf'],['ARIALNB.TTF','LiberationSansNarrow-Bold.ttf'],['ARIALNI.TTF','LiberationSansNarrow-Italic.ttf'],['ARIALNBI.TTF','LiberationSansNarrow-BoldItalic.ttf']]
async function sandboxFonts() {
  const runtime = path.join(process.cwd(), 'server/lease/runtime/fonts')
  return (await Promise.all(fontFiles.map(async ([name, file]) => {
    const content = await readFile(path.join(runtime, file))
    return [name, name.toLowerCase()].map(alias => ({ path: `${fontHome}/.local/share/fonts/${alias}`, content }))
  }))).flat()
}
export const bucket = 'lease-plans'
export const key = (job, file) => `${job.user_id}/${job.id}/${file}`
export function checked(result) { if (result.error) throw result.error; return result.data }

/**
 * The source drawing, read server-side from SharePoint through the existing
 * `file` function, which fetches it with the app-only Graph credentials after
 * checking that `bearer` belongs to an active account.
 *
 * The browser no longer hands us the bytes. It used to: it downloaded the DWG
 * from SharePoint, uploaded it to a signed storage URL, and we read it back.
 * That meant the drawing a job ran on was whatever the client chose to upload,
 * while the `source` recorded in the manifest was whatever the client claimed —
 * two facts with nothing tying them together. Fetching by driveId and itemId
 * ourselves makes the bytes authoritative, and lets the server verify the
 * name Microsoft reports against the name the request was validated against.
 *
 * `bearer` is the caller's own token. It is used for this one call, is never
 * written to the database or logged, and never enters the sandbox.
 */
export async function fetchSource(job, bearer) {
  const source = job.request?.source || {}
  if (!source.driveId || !source.id) throw new Error('This drawing is missing its SharePoint location. Locate it again.')
  const response = await fetch(`${process.env.VITE_SUPABASE_URL}/functions/v1/file`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      apikey: process.env.VITE_SUPABASE_ANON_KEY || '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ driveId: source.driveId, itemId: source.id, mode: 'download' }),
  })
  // Deliberately not the upstream body: a Graph failure can carry a signed URL.
  if (!response.ok) throw new Error(`Could not read the source drawing from SharePoint (${response.status}). Locate it again in Browse.`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > sourceLimit) throw new Error('This pilot supports DWGs up to 24 MB.')
  // Microsoft's own name for the item, versus the one the request was checked
  // against. A mismatch means the file was renamed or a different item was
  // asked for, and either way the unit check no longer holds. When the header
  // is absent nothing is claimed either way: the bytes are still the ones
  // SharePoint holds for this item id, only the name is unverified.
  const reported = (response.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (reported && source.name) {
    let actual = reported
    try { actual = decodeURIComponent(reported) } catch { /* keep the raw header value */ }
    if (actual !== source.name) throw new Error(`This drawing is now called "${actual}" in SharePoint. Locate it again before preparing a review.`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Run one job to completion. `source` is the generate job's drawing, as bytes
 * or as a function returning them — a function so that a fetch failure lands
 * in the one handler below that keeps SDK messages away from the user.
 */
export async function runJob(db, job, { credentials = {}, source } = {}) {
  let sandbox
  try {
    const input = { kind: job.kind, request: { ...job.request, requestId: job.id } }
    let bytes
    if (job.kind === 'edit') {
      const parent = checked(await db.from('lease_jobs').select('*').eq('id', job.request.reviewId).eq('user_id', job.user_id).eq('status','ready').single())
      input.parent = parent.review
      bytes = Buffer.from(await checked(await db.storage.from(bucket).download(key(parent, 'result.dwg'))).arrayBuffer())
    } else {
      bytes = typeof source === 'function' ? await source() : source
    }
    if (!Buffer.isBuffer(bytes) || bytes.length > sourceLimit || !/^AC10\d\d/.test(bytes.subarray(0,6).toString())) throw new Error('The source is not a supported DWG, or exceeds 24 MB.')
    sandbox = await Sandbox.create({ ...credentials, persistent: false, timeout: 240000, resources: { vcpus: 2 }, networkPolicy: {allow: ['github.com','release-assets.githubusercontent.com']} })
    const installed = await sandbox.runCommand({cmd:'bash',args:['-c',install]})
    if (installed.exitCode !== 0) throw new Error('The drawing engine could not start. Please try again.')
    // No network or credentials are available to the CAD process.
    await sandbox.updateNetworkPolicy('deny-all')
    const files = ['cadcraft_bridge.py','studio_worker.py','studio_edits.py','run_job.py']
    await sandbox.writeFiles([
      ...await Promise.all(files.map(async name => ({path:'/tmp/'+name,content:await readFile(path.join(process.cwd(),'server/lease/runtime',name))}))),
      {path:'/tmp/source.dwg',content:bytes},
      {path:'/tmp/input.json',content:Buffer.from(JSON.stringify(input))},
      ...await sandboxFonts(),
    ])
    const result = await sandbox.runCommand({cmd:'env',args:[`HOME=${fontHome}`,'python3','/tmp/run_job.py',engine]})
    if (result.exitCode !== 0) throw new Error('The drawing engine stopped before validation finished. Your previous review is unchanged.')
    const outcome = JSON.parse((await sandbox.readFileToBuffer({path:'/tmp/outcome.json'})).toString())
    if (!outcome.ok) throw new Error(outcome.error)
    const review = JSON.parse((await sandbox.readFileToBuffer({path:'/tmp/review.json'})).toString())
    for (const [file,type] of [['result.dwg','application/octet-stream'],['result.pdf','application/pdf'],['editor.json','application/json']]) {
      const output = await sandbox.readFileToBuffer({path:'/tmp/'+file})
      if (!output || output.length>sourceLimit) throw new Error('The generated file exceeds the review limit.')
      checked(await db.storage.from(bucket).upload(key(job,file),output,{contentType:type,upsert:false}))
    }
    checked(await db.from('lease_jobs').update({status:'ready',review,updated_at:new Date().toISOString()}).eq('id',job.id).eq('status','processing'))
  } catch(error) {
    // Never return SDK errors which may contain signed URLs or credentials.
    const safe = error instanceof Error && !/https?:|token|authorization|apikey/i.test(error.message) ? error.message.slice(0,350) : 'Cloud processing stopped. Please try a new review.'
    await db.from('lease_jobs').update({status:'failed',error:safe,updated_at:new Date().toISOString()}).eq('id',job.id).eq('status','processing')
  } finally {
    // Nothing of the source is left behind to clean up: it is fetched into
    // memory and written straight into the sandbox, never into storage.
    if (sandbox) await sandbox.stop().catch(()=>{})
  }
}
