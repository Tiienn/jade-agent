import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, ExternalLink, FilePenLine, FolderUp, Loader2, Search, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import LeaseEditor from '../components/LeaseEditor'
import LeasePdfPreview from '../components/LeasePdfPreview'
import { useAuth } from '../context/AuthContext'
import type { FileResult } from '../lib/api'
import { deleteLeasePlan, generateLeaseReview, leaseLibrary, leaseProjects, leaseReviewFile, listLeaseJobs, locateLeaseDrawing, publishLeasePlan, type LeaseJob, type LeaseLibraryPlan, type LeaseReview } from '../lib/leasePlanApi'

const inputClass = 'mt-1.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-jade-500'
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg bg-jade-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-jade-700 disabled:cursor-not-allowed disabled:opacity-50'
const dangerClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50'
const secondaryClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Indian/Mauritius', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

export default function LeasePlans() {
  const { profile } = useAuth()
  const [project, setProject] = useState('Palm Square')
  const [projects, setProjects] = useState<string[]>([])
  const [unit, setUnit] = useState('F18')
  const [connectionError, setConnectionError] = useState('Connecting to cloud processing…')
  const [tenant, setTenant] = useState('')
  const [date, setDate] = useState(today)
  const [connected, setConnected] = useState(false)
  const [jobs, setJobs] = useState<LeaseJob[]>([])
  const [editing, setEditing] = useState(false)
  const [sources, setSources] = useState<FileResult[]>([])
  const [sourceId, setSourceId] = useState('')
  const [searched, setSearched] = useState(false)
  const [locating, setLocating] = useState(false)
  const [reviews, setReviews] = useState<LeaseReview[]>([])
  const [review, setReview] = useState<LeaseReview | null>(null)
  const [preview, setPreview] = useState('')
  const previewRef = useRef('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [library, setLibrary] = useState<LeaseLibraryPlan[]>([])
  const source = sources.find(f => f.id === sourceId)
  // The plan on screen may be a colleague's, opened from the shared library, so
  // what you may do with it comes from the library entry rather than from the
  // fact that it is open: read and download always, edit and file only if it is
  // yours (or you administer the site, for someone away or gone).
  const isAdmin = profile?.role === 'admin'
  const entry = review ? library.find(plan => plan.id === review.id) : undefined
  const ownJob = review ? jobs.find(job => job.id === review.id) : undefined
  const publication = ownJob?.published ?? entry?.published ?? null
  const mine = entry?.mine ?? !!ownJob
  const filedPdfUrl = publication?.items.find(item => item.name.toLowerCase().endsWith('.pdf'))?.webUrl ?? null
  // Editing a plan produces a new review and leaves the old one ready, so the
  // shared list would otherwise show every superseded version of a unit beside
  // its current one. Your own dropdown still lists all of yours.
  const superseded = new Set(library.map(plan => plan.review?.parentReviewId).filter((id): id is string => !!id))
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current) }, [])

  useEffect(() => {
    void leaseProjects().then(setProjects).catch(e => setError(e.message))
  }, [])
  useEffect(() => {
    let cancelled=false
    setSources([]); setSourceId(''); setSearched(false); setLocating(false); setError('')
    if (!project || !unit.trim()) return
    const timer=window.setTimeout(async()=>{
      setLocating(true)
      try {
        const files=await locateLeaseDrawing(project,unit.trim())
        if(!cancelled) {setSources(files);setSourceId(files[0]?.id??'');setSearched(true)}
      } catch(e) {if(!cancelled)setError(e instanceof Error?e.message:'Could not locate the source drawing.')}
      finally {if(!cancelled)setLocating(false)}
    },700)
    return ()=>{cancelled=true;window.clearTimeout(timer)}
  }, [project, unit])
  // Your own jobs decide what this page lets you do, so a failure there is a
  // connection failure. The shared library is additional: if it alone fails --
  // the case right after a deploy whose migration has not run yet -- the page
  // keeps working on your own plans instead of going dark.
  const refresh = useCallback(async () => {
    const [saved, shared] = await Promise.allSettled([listLeaseJobs(), leaseLibrary()])
    if (saved.status === 'rejected') throw saved.reason
    setJobs(saved.value)
    setReviews(saved.value.filter(j => j.status === 'ready' && j.review).map(j => j.review!))
    if (shared.status === 'fulfilled') setLibrary(shared.value)
  }, [])
  useEffect(() => {
    let stopped = false
    let pending = false
    async function reconnect() {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      try {
        await refresh()
        if (!stopped) { setConnected(true); setConnectionError('') }
      } catch (e) {
        if (!stopped) { setConnected(false); setConnectionError(e instanceof Error ? e.message : 'Cloud processing unavailable.') }
      } finally { pending = false }
    }
    void reconnect()
    const timer = window.setInterval(() => void reconnect(), 15000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [refresh])

  async function act(label: string, work: () => Promise<void>) {
    setBusy(label); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : 'Could not complete the request.') }
    finally { setBusy('') }
  }
  async function showReview(item: LeaseReview) {
    const blob = await leaseReviewFile(item, 'pdf')
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = URL.createObjectURL(blob)
    setPreview(previewRef.current); setReview(item)
  }
  // Permanent: the review's DWG, PDF and editor copy go, and nothing keeps a
  // backup. The source drawing in SharePoint is never touched, so a deleted
  // plan can always be generated again. Filed plans are refused by the API.
  async function removePlan(item: LeaseReview) {
    const name = `${item.project || 'Palm Square'} / ${item.unit || 'F18'} — ${item.tenant}, ${item.date}`
    if (!window.confirm(`Delete ${name}?\n\nIts DWG and PDF are removed for good. The source drawing in SharePoint is not affected, so you can prepare the plan again.`)) return
    await act('Deleting plan…', async () => {
      await deleteLeasePlan(item.id)
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
      previewRef.current = ''
      setPreview(''); setReview(null)
      await refresh()
    })
  }
  async function download(kind: 'dwg' | 'pdf') {
    if (!review) return
    const blob = await leaseReviewFile(review, kind)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = review[kind]; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 30000)
  }
  return <div className="flex-1 overflow-y-auto">
    {editing && review && <LeaseEditor review={review} onClose={() => setEditing(false)} onSaved={item => { setEditing(false); setReviews(previous => [item, ...previous.filter(r=>r.id!==item.id)]); void act('Opening updated review…', () => showReview(item)) }} />}
    <header className="border-b border-gray-200 bg-white px-6 py-5">
      <div className="flex items-center gap-3"><FilePenLine className="text-jade-600" size={24} /><h1 className="text-xl font-semibold text-gray-900">Lease plans</h1></div>
      <p className="mt-2 text-sm text-gray-500">Choose a project and unit, then prepare your DWG and PDF.</p>
    </header>
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      {error && <div role="alert" className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="space-y-6">
          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold text-gray-900">Jade Lease Studio</h2>
            <p role="status" className="mt-3 text-sm text-gray-700">{connected ? <span className="inline-flex items-center gap-2"><CheckCircle2 size={16} className="text-jade-600" /> Cloud processing ready</span> : connectionError}</p>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">No installation or connection code. Submitted jobs run in the cloud and reviews stay in your Jade Agent account. Choose any project and unit. Each drawing is checked before its DWG and PDF are saved.</p>
            {jobs.some(j => ['uploading','processing'].includes(j.status)) && <p role="status" className="mt-3 text-sm text-jade-700">A plan is processing. You can return here for the completed review.</p>}
            {jobs.length > 0 && <details className="mt-3 text-xs text-gray-500"><summary>Recent jobs</summary><ul className="mt-2 space-y-2">{jobs.slice(0,5).map(j=><li key={j.id}>{new Date(j.created_at).toLocaleString('en-GB')} — {j.status === 'ready' ? 'Ready for review' : j.status}{j.error && <span className="block text-red-700">{j.error}</span>}</li>)}</ul></details>}
          </section>
          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between gap-3"><h2 className="font-semibold text-gray-900">Source drawing</h2><button className={secondaryClass} disabled={!!busy || locating || !project || !unit.trim()} onClick={() => void act(`Locating ${unit} in ${project}…`, async () => {
              setSources([]); setSourceId(''); setSearched(false)
              const files = await locateLeaseDrawing(project, unit.trim())
              setSources(files); setSourceId(files[0]?.id ?? ''); setSearched(true)
            })}><Search size={16} /> {locating ? 'Locating…' : 'Refresh drawing'}</button></div>
            <label className="mt-4 block text-sm font-medium text-gray-700">Project<select value={project} disabled={!!busy} className={inputClass} onChange={e => setProject(e.target.value)}>{!projects.length && <option value="Palm Square">Loading projects…</option>}{projects.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
            <label className="mt-4 block text-sm font-medium text-gray-700">Unit number<input value={unit} maxLength={20} placeholder="e.g. F18, 5D or 101" disabled={!!busy} onChange={e => setUnit(e.target.value.toUpperCase().replaceAll('/', '.'))} className={inputClass} /></label>
            <p className="mt-3 text-sm text-gray-500">Automatically finds the latest matching DWG when you choose a project and enter a unit. Use a dot for combined units, such as F4.5.</p>
            {searched && !sources.length && <p className="mt-4 text-sm text-amber-700">No matching DWG found in this project’s lease folders. Check the source in Browse.</p>}
            {source && <div className="mt-4 border-l-2 border-jade-600 pl-3"><p className="break-words text-sm font-medium text-gray-900">{source.name}</p><p className="mt-1 text-xs text-gray-500">Modified {new Date(source.lastModified).toLocaleString('en-GB', { timeZone: 'Indian/Mauritius' })}</p><p className="mt-2 break-words text-xs text-gray-500">{source.path}</p></div>}
            {sources.length > 1 && <details className="mt-3 text-xs text-gray-500"><summary className="cursor-pointer">{sources.length - 1} older drawing(s)</summary><ul className="mt-2 space-y-2">{sources.slice(1).map(f => <li className="break-words" key={f.id}>{f.name}</li>)}</ul></details>}
            <Link className="mt-4 inline-block text-sm text-jade-700 underline" to={`/browse?path=${encodeURIComponent(project)}`}>Open source folder</Link>
          </section>
          <form className="rounded-xl border border-gray-200 bg-white p-5" onSubmit={e => {
            e.preventDefault()
            if (!source) return
            void act('Updating the DWG and exporting the PDF…', async () => {
              const item = await generateLeaseReview(source, tenant.trim(), date, project, unit.trim())
              setReviews(previous => [item, ...previous]); await showReview(item)
            })
          }}>
            <h2 className="font-semibold text-gray-900">Prepare a review set</h2>
            <label className="mt-4 block text-sm font-medium text-gray-700">Tenant name<input required maxLength={70} placeholder="e.g. Dr. Antoine Leuteritz" value={tenant} onChange={e => setTenant(e.target.value)} disabled={!!busy} className={inputClass} /></label>
            <label className="mt-4 block text-sm font-medium text-gray-700">Drawing date<input required type="date" min="2000-01-01" max="2100-12-31" value={date} onChange={e => setDate(e.target.value)} disabled={!!busy} className={inputClass} /></label>
            <p className="mt-4 text-xs leading-relaxed text-gray-500">Preserves the existing unit outline and scale. After generation, adjust the highlight and add text in the browser. Saves separate DWG and PDF copies for review.</p>
            <button type="submit" className={`${buttonClass} mt-5 w-full`} disabled={!!busy || locating || !connected || !source || !tenant.trim() || !date || jobs.some(j => ['uploading','processing'].includes(j.status))}><FilePenLine size={17} /> Save DWG and PDF for review</button>
          </form>
          {busy && <p role="status" className="flex items-center gap-2 text-sm text-jade-700"><Loader2 size={17} className="animate-spin" />{busy}</p>}
          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold text-gray-900">All lease plans</h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">Every finished plan the team has prepared. Open one to review or download it. The person who prepared it, or an admin, can file it to SharePoint.</p>
            {!library.length && <p className="mt-3 text-sm text-gray-500">No finished plans yet.</p>}
            <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">{library.filter(plan => plan.review && !superseded.has(plan.id)).map(plan => <li key={plan.id}><button className="w-full rounded-lg px-2 py-2 text-left hover:bg-gray-50 disabled:opacity-50" disabled={!!busy} onClick={() => void act('Opening plan…', () => showReview(plan.review!))}><span className="block break-words text-sm font-medium text-gray-900">{plan.review!.project || 'Palm Square'} / {plan.review!.unit || 'F18'} — {plan.review!.tenant}</span><span className="mt-0.5 block text-xs text-gray-500">{plan.review!.date} · {plan.mine ? 'You' : plan.preparedBy}{plan.published_at ? ' · in SharePoint' : ''}</span></button></li>)}</ul>
          </section>
        </div>
        <section className="min-w-0 rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 p-5"><h2 className="font-semibold text-gray-900">Review your plan</h2><p className="mt-1 text-sm text-gray-500">Check the tenant, date, unit outline and drawing before using it.</p></div>
          {reviews.length > 0 && <div className="border-b border-gray-200 p-4"><label className="block text-sm text-gray-700">Your saved reviews<select className={inputClass} value={review?.id ?? ''} disabled={!!busy} onChange={e => { const item = reviews.find(r => r.id === e.target.value); if (item) void act('Opening review…', () => showReview(item)) }}><option value="" disabled>Choose a review set</option>{reviews.map(r => <option value={r.id} key={r.id}>{r.project || 'Palm Square'} / {r.unit || 'F18'} — {r.tenant} — {r.date} — {new Date(r.createdAt).toLocaleTimeString()}</option>)}</select></label></div>}
          {review ? <>
            <div className="space-y-3 p-5"><div className="flex flex-wrap gap-2">{mine && <button className={secondaryClass} disabled={!!busy || jobs.some(j => ['uploading','processing'].includes(j.status))} onClick={() => setEditing(true)}><FilePenLine size={16} /> Edit highlight and text</button>}<button className={secondaryClass} disabled={!!busy} onClick={() => void act('Downloading PDF…', () => download('pdf'))}><Download size={16} /> Download PDF</button><button className={secondaryClass} disabled={!!busy} onClick={() => void act('Downloading DWG…', () => download('dwg'))}><Download size={16} /> Download DWG</button>{(mine || isAdmin) && !publication && <button className={buttonClass} disabled={!!busy} onClick={() => void act('Filing to SharePoint…', async () => { await publishLeasePlan(review.id); await refresh() })}><FolderUp size={17} /> Save to SharePoint</button>}{filedPdfUrl && <a className={secondaryClass} href={filedPdfUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open in SharePoint</a>}{mine && !publication && <button className={dangerClass} disabled={!!busy || jobs.some(j => ['uploading','processing'].includes(j.status))} onClick={() => void removePlan(review)}><Trash2 size={16} /> Delete</button>}</div><p className="text-sm font-medium text-gray-700">{review.paper}</p>{publication ? <p className="break-words text-xs text-gray-600">Filed in SharePoint under {publication.folder}</p> : <p className="break-words text-xs text-gray-500">Not filed to SharePoint yet. Filing saves a copy of this DWG and PDF into the library — the source drawing is never changed.</p>}<ul className="space-y-1 text-xs text-gray-600">{review.checks.map(check => <li key={check} className="flex items-start gap-2"><CheckCircle2 size={14} className="shrink-0 text-jade-600" />{check}</li>)}</ul></div>
            <LeasePdfPreview url={preview} />
          </> : <div className="flex min-h-[500px] flex-col items-center justify-center px-8 text-center"><FilePenLine size={42} strokeWidth={1} className="text-gray-400" /><p className="mt-5 font-medium text-gray-700">Your lease plan will appear here</p><p className="mt-2 max-w-sm text-sm leading-relaxed text-gray-500">Locate the source drawing, enter the tenant and date, then save the review set.</p></div>}
        </section>
      </div>
    </div>
  </div>
}
