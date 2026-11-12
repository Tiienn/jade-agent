import { mkdir, copyFile } from 'node:fs/promises'
await mkdir('server/lease/runtime',{recursive:true})
for (const [name,source] of Object.entries({
 'cadcraft_bridge.py':'scripts/lease_plans/cadcraft_bridge.py',
 'studio_worker.py':'apps/jade-lease-studio/worker/studio_worker.py',
 'studio_edits.py':'apps/jade-lease-studio/worker/studio_edits.py',
 'run_job.py':'server/lease/run_job.py',
})) await copyFile(source,'server/lease/runtime/'+name)
await mkdir('public/lease-editor',{recursive:true})
for (const name of ['editor.css','editor.html','editor.js']) await copyFile('apps/jade-lease-studio/ui/'+name,'public/lease-editor/'+name)
// The web build communicates only with its same-origin parent, never a local helper.
const {readFile,writeFile}=await import('node:fs/promises')
let script=await readFile('public/lease-editor/editor.js','utf8')
script=script.replace('function post(message){window.chrome.webview.postMessage(message);}', `function post(message){window.parent.postMessage({channel:'jade-lease-editor',message},window.location.origin);}
window.addEventListener('message',event=>{if(event.origin!==window.location.origin||event.source!==window.parent)return;if(event.data?.type==='plan')window.loadPlan(event.data.value);if(event.data?.type==='error')window.saveFailed(event.data.value);});`)
await writeFile('public/lease-editor/editor.js',script)
