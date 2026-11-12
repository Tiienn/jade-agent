import { useEffect, useRef, useState } from 'react'
import { leaseEditorPlan, saveLeaseEdits, type LeaseReview } from '../lib/leasePlanApi'

export default function LeaseEditor({review,onClose,onSaved}:{review:LeaseReview;onClose:()=>void;onSaved:(review:LeaseReview)=>void}) {
 const frame=useRef<HTMLIFrameElement>(null)
 const [error,setError]=useState('')
 const callbacks=useRef({onClose,onSaved})
 callbacks.current={onClose,onSaved}
 useEffect(()=>{
  let stopped=false, saving=false
  const send=(type:string,value:unknown)=>frame.current?.contentWindow?.postMessage({type,value},window.location.origin)
  const listener=async(event:MessageEvent)=>{
   if(event.origin!==window.location.origin||event.source!==frame.current?.contentWindow||event.data?.channel!=='jade-lease-editor') return
   const message=event.data.message
   if(message?.action==='ready') {
    try { const plan=await leaseEditorPlan(review); if(!stopped) send('plan',plan) }
    catch(e) {if(!stopped) setError(e instanceof Error?e.message:'Could not open the plan.')}
   }
   if(message?.action==='cancel'&&!saving) callbacks.current.onClose()
   if(message?.action==='save'&&!saving) {
    saving=true
    try {
     const result=await saveLeaseEdits({reviewId:review.id,sourceSha256:message.sourceSha256,outline:message.outline,notes:message.notes})
     if(!stopped) callbacks.current.onSaved(result)
    } catch(e) {if(!stopped) send('error',e instanceof Error?e.message:'Could not save this edit.')}
    finally {saving=false}
   }
  }
  window.addEventListener('message',listener)
  return ()=>{stopped=true;window.removeEventListener('message',listener)}
 },[review.id])
 return <div role="dialog" aria-modal="true" aria-label="Edit lease plan" className="fixed inset-0 z-50 bg-white">
  {error?<div role="alert" className="p-6">{error}<button className="ml-4 underline" onClick={onClose}>Close editor</button></div>:<iframe ref={frame} title="Lease plan highlight and text editor" src="/lease-editor/editor.html" className="h-full w-full border-0" />}
 </div>
}
