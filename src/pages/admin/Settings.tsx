import { useCallback, useEffect, useState } from 'react'
import {
  Building2,
  Loader2,
  AlertCircle,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import ConfirmDialog from '../../components/admin/ConfirmDialog'

interface Building {
  id: string
  code: string
  name: string
  root_path: string
  created_at: string
}

interface Draft {
  code: string
  name: string
  root_path: string
}

const EMPTY_DRAFT: Draft = { code: '', name: '', root_path: '' }

/** Trim surrounding whitespace and leading/trailing slashes from a folder path. */
function cleanPath(p: string): string {
  return p.trim().replace(/^\/+|\/+$/g, '')
}

/** Returns an error message if the draft is invalid, else null. */
function validateDraft(d: Draft): string | null {
  const code = d.code.trim().toUpperCase()
  if (!code) return 'Code is required.'
  if (code.length > 5) return 'Code must be 1–5 characters.'
  if (!d.name.trim()) return 'Name is required.'
  if (!cleanPath(d.root_path)) return 'Folder path is required.'
  return null
}

function friendlyDbError(err: unknown, fallback: string): string {
  const e = err as { code?: string; message?: string } | null
  if (e?.code === '23505') return 'That code is already in use. Choose a different one.'
  return e?.message || fallback
}

export default function Settings() {
  const [buildings, setBuildings] = useState<Building[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editError, setEditError] = useState<string | null>(null)

  const [addDraft, setAddDraft] = useState<Draft>(EMPTY_DRAFT)
  const [addError, setAddError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const [saving, setSaving] = useState(false)
  const [toDelete, setToDelete] = useState<Building | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error: dbError } = await supabase
      .from('buildings')
      .select('id, code, name, root_path, created_at')
      .order('code', { ascending: true })
    if (dbError) {
      setError('Could not load buildings. Please try again.')
      setBuildings(null)
    } else {
      setBuildings(data as Building[])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function startEdit(b: Building) {
    setEditingId(b.id)
    setEditDraft({ code: b.code, name: b.name, root_path: b.root_path })
    setEditError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft(EMPTY_DRAFT)
    setEditError(null)
  }

  async function saveEdit(id: string) {
    const msg = validateDraft(editDraft)
    if (msg) {
      setEditError(msg)
      return
    }
    setSaving(true)
    setEditError(null)
    const { error: dbError } = await supabase
      .from('buildings')
      .update({
        code: editDraft.code.trim().toUpperCase(),
        name: editDraft.name.trim(),
        root_path: cleanPath(editDraft.root_path),
      })
      .eq('id', id)
    setSaving(false)
    if (dbError) {
      setEditError(friendlyDbError(dbError, 'Could not save changes.'))
      return
    }
    cancelEdit()
    load()
  }

  async function saveAdd() {
    const msg = validateDraft(addDraft)
    if (msg) {
      setAddError(msg)
      return
    }
    setSaving(true)
    setAddError(null)
    const { error: dbError } = await supabase.from('buildings').insert({
      code: addDraft.code.trim().toUpperCase(),
      name: addDraft.name.trim(),
      root_path: cleanPath(addDraft.root_path),
    })
    setSaving(false)
    if (dbError) {
      setAddError(friendlyDbError(dbError, 'Could not add the building.'))
      return
    }
    setAddDraft(EMPTY_DRAFT)
    setShowAdd(false)
    load()
  }

  async function confirmDelete() {
    if (!toDelete) return
    setDeleting(true)
    const { error: dbError } = await supabase
      .from('buildings')
      .delete()
      .eq('id', toDelete.id)
    setDeleting(false)
    if (dbError) {
      setError(friendlyDbError(dbError, 'Could not delete the building.'))
      setToDelete(null)
      return
    }
    setToDelete(null)
    load()
  }

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">
          Buildings
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          Each building maps a short code to a SharePoint folder. The folder path
          is relative to the site's Documents library — the default pattern is{' '}
          <span className="font-mono text-gray-700">
            Marketing/Project/&lt;Building Name&gt;
          </span>
          . Changes take effect on the next search automatically.
        </p>
      </div>

      {error && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div className="mt-6 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-gray-200 bg-white"
            />
          ))}
        </div>
      )}

      {!loading && buildings && (
        <>
          {/* Table header (desktop) */}
          <div className="mt-6 hidden grid-cols-[6rem_1fr_1.5fr_auto] gap-3 px-4 pb-2 text-xs font-medium uppercase tracking-wide text-gray-400 sm:grid">
            <span>Code</span>
            <span>Name</span>
            <span>Folder path</span>
            <span className="text-right">Actions</span>
          </div>

          <ul className="space-y-3 sm:space-y-2">
            {buildings.map((b) =>
              editingId === b.id ? (
                <li
                  key={b.id}
                  className="rounded-xl border border-jade-200 bg-white p-4"
                >
                  <BuildingFields
                    draft={editDraft}
                    onChange={setEditDraft}
                    error={editError}
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      onClick={cancelEdit}
                      disabled={saving}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
                    >
                      <X size={15} />
                      Cancel
                    </button>
                    <button
                      onClick={() => saveEdit(b.id)}
                      disabled={saving}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-jade-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
                    >
                      {saving ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <Check size={15} />
                      )}
                      Save
                    </button>
                  </div>
                </li>
              ) : (
                <li
                  key={b.id}
                  className="rounded-xl border border-gray-200 bg-white p-4 sm:grid sm:grid-cols-[6rem_1fr_1.5fr_auto] sm:items-center sm:gap-3 sm:py-3"
                >
                  <span className="inline-flex items-center rounded-md bg-gray-100 px-2 py-0.5 font-mono text-sm font-semibold text-gray-800">
                    {b.code}
                  </span>
                  <p className="mt-2 text-sm font-medium text-gray-900 sm:mt-0">
                    {b.name}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-gray-500 sm:mt-0 sm:text-sm">
                    {b.root_path}
                  </p>
                  <div className="mt-3 flex gap-2 sm:mt-0 sm:justify-end">
                    <button
                      onClick={() => startEdit(b)}
                      className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                      aria-label={`Edit ${b.name}`}
                    >
                      <Pencil size={15} />
                      <span className="sm:hidden">Edit</span>
                    </button>
                    <button
                      onClick={() => setToDelete(b)}
                      className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
                      aria-label={`Delete ${b.name}`}
                    >
                      <Trash2 size={15} />
                      <span className="sm:hidden">Delete</span>
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>

          {/* Add building */}
          {showAdd ? (
            <div className="mt-3 rounded-xl border border-jade-200 bg-white p-4">
              <BuildingFields
                draft={addDraft}
                onChange={setAddDraft}
                error={addError}
                autoFocus
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => {
                    setShowAdd(false)
                    setAddDraft(EMPTY_DRAFT)
                    setAddError(null)
                  }}
                  disabled={saving}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
                >
                  <X size={15} />
                  Cancel
                </button>
                <button
                  onClick={saveAdd}
                  disabled={saving}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-jade-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-jade-700 disabled:opacity-60"
                >
                  {saving ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Check size={15} />
                  )}
                  Add building
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-dashed border-gray-300 bg-white px-4 text-sm font-medium text-gray-600 transition-colors hover:border-jade-300 hover:bg-jade-50 hover:text-jade-700"
            >
              <Plus size={16} />
              Add building
            </button>
          )}

          {buildings.length === 0 && !showAdd && (
            <div className="mt-6 flex flex-col items-center rounded-xl border border-gray-200 bg-white py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 text-gray-400">
                <Building2 size={24} />
              </div>
              <p className="mt-3 text-sm font-medium text-gray-900">
                No buildings yet
              </p>
              <p className="mt-1 text-sm text-gray-500">
                Add one so workers can search its files.
              </p>
            </div>
          )}
        </>
      )}

      {toDelete && (
        <ConfirmDialog
          title={`Delete ${toDelete.name}?`}
          message="Workers will no longer be able to search this building."
          confirmLabel="Delete"
          destructive
          busy={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setToDelete(null)}
        />
      )}
    </div>
  )
}

function BuildingFields({
  draft,
  onChange,
  error,
  autoFocus = false,
}: {
  draft: Draft
  onChange: (d: Draft) => void
  error: string | null
  autoFocus?: boolean
}) {
  return (
    <div>
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-[6rem_1fr_1.5fr]">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500 sm:hidden">
            Code
          </span>
          <input
            type="text"
            autoFocus={autoFocus}
            autoCapitalize="characters"
            autoCorrect="off"
            maxLength={5}
            value={draft.code}
            onChange={(e) =>
              onChange({ ...draft, code: e.target.value.toUpperCase() })
            }
            placeholder="RT"
            aria-label="Code"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 font-mono text-sm uppercase outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500 sm:hidden">
            Name
          </span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="Rivertown"
            aria-label="Name"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500 sm:hidden">
            Folder path
          </span>
          <input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            value={draft.root_path}
            onChange={(e) => onChange({ ...draft, root_path: e.target.value })}
            placeholder="Marketing/Project/Rivertown"
            aria-label="Folder path"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 font-mono text-sm outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
          />
        </label>
      </div>
    </div>
  )
}
