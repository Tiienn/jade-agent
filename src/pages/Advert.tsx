import { useMemo, useState } from 'react'
import { ExternalLink, Megaphone } from 'lucide-react'
import advertsRaw from '../data/adverts.json'

interface Advert {
  type: string
  location: string
  unit: string
  status: string
  price: string
  lexpress: string
  propertyCloud: string
}

const ADVERTS = advertsRaw as Advert[]

const TYPES = ['Land', 'Office', 'Commercial', 'House/Apartment']

/** Distinct, sorted locations across the whole dataset (for the filter). */
const LOCATIONS = Array.from(new Set(ADVERTS.map((a) => a.location)))
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b))

const selectClass =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900'

/** Small status pill: Sell → jade tint, Rent → neutral. */
function StatusPill({ status }: { status: string }) {
  const isSell = status === 'Sell'
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
        isSell
          ? 'bg-jade-50 text-jade-700 dark:text-jade-300'
          : 'bg-gray-100 text-gray-600'
      }`}
    >
      {status}
    </span>
  )
}

/** External listing link, or a muted dash when the URL is empty. */
function ListingLink({ url }: { url: string }) {
  if (!url) return <span className="text-gray-400">—</span>
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-jade-700 hover:underline dark:text-jade-300"
    >
      <ExternalLink size={16} />
      Open
    </a>
  )
}

/** Simple stat card matching the admin StatCard look. */
function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-2xl font-semibold tracking-tight text-gray-900">
        {value}
      </p>
      <p className="mt-0.5 text-xs uppercase tracking-wide text-gray-400">
        {label}
      </p>
    </div>
  )
}

export default function Advert() {
  const [type, setType] = useState('all')
  const [location, setLocation] = useState('all')
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ADVERTS.filter((a) => {
      if (type !== 'all' && a.type !== type) return false
      if (location !== 'all' && a.location !== location) return false
      if (status !== 'all' && a.status !== status) return false
      if (q) {
        const haystack = [a.type, a.location, a.unit, a.status, a.price]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [type, location, status, query])

  const stats = useMemo(() => {
    const byType = (t: string) => filtered.filter((a) => a.type === t).length
    return {
      total: filtered.length,
      locations: new Set(filtered.map((a) => a.location)).size,
      land: byType('Land'),
      office: byType('Office'),
      commercial: byType('Commercial'),
      houseApartment: byType('House/Apartment'),
    }
  }, [filtered])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
        {/* Heading */}
        <div className="mt-2">
          <h1 className="text-lg font-semibold text-gray-900">Adverts</h1>
          <p className="mt-0.5 text-sm text-gray-500">All property listings.</p>
        </div>

        {/* Stat cards */}
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Locations" value={stats.locations} />
          <StatCard label="Land" value={stats.land} />
          <StatCard label="Office" value={stats.office} />
          <StatCard label="Commercial" value={stats.commercial} />
          <StatCard label="House/Apartment" value={stats.houseApartment} />
        </div>

        {/* Filter row */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <select
            aria-label="Filter by property type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={selectClass}
          >
            <option value="all">All types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className={selectClass}
          >
            <option value="all">All locations</option>
            {LOCATIONS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={selectClass}
          >
            <option value="all">All statuses</option>
            <option value="Sell">Sell</option>
            <option value="Rent">Rent</option>
          </select>

          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search adverts…"
            aria-label="Search adverts"
            className="min-w-[12rem] flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
          />
        </div>

        {/* Result count */}
        <p className="mt-4 text-sm text-gray-500">
          {filtered.length} advert{filtered.length === 1 ? '' : 's'}
        </p>

        {/* Empty state */}
        {filtered.length === 0 ? (
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
              <Megaphone size={26} />
            </div>
            <p className="mt-3 text-sm font-medium text-gray-900">
              No adverts match your filters.
            </p>
            <p className="mt-1 max-w-xs text-sm text-gray-500">
              Try adjusting the type, location, status, or search.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="mt-3 hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                    <th className="px-3 py-3">#</th>
                    <th className="px-3 py-3">Property Type</th>
                    <th className="px-3 py-3">Location/Building</th>
                    <th className="px-3 py-3">Unit No.</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Price</th>
                    <th className="px-3 py-3">L'Express</th>
                    <th className="px-3 py-3">Property Cloud</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a, i) => (
                    <tr
                      key={i}
                      className="border-b border-gray-100 hover:bg-gray-50"
                    >
                      <td className="px-3 py-3 align-middle text-gray-400">
                        {i + 1}
                      </td>
                      <td className="px-3 py-3 align-middle font-medium text-gray-900">
                        {a.type}
                      </td>
                      <td className="px-3 py-3 align-middle text-gray-900">
                        {a.location || '—'}
                      </td>
                      <td className="px-3 py-3 align-middle text-gray-900">
                        {a.unit || '—'}
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <StatusPill status={a.status} />
                      </td>
                      <td className="px-3 py-3 align-middle text-gray-900">
                        {a.price || '—'}
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <ListingLink url={a.lexpress} />
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <ListingLink url={a.propertyCloud} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="mt-3 space-y-3 md:hidden">
              {filtered.map((a, i) => (
                <div
                  key={i}
                  className="space-y-1 rounded-xl border border-gray-200 bg-white p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-900">{a.type}</span>
                    <StatusPill status={a.status} />
                  </div>
                  <p className="text-sm text-gray-500">
                    {a.location || '—'}
                    {a.unit ? ` · ${a.unit}` : ''}
                  </p>
                  <p className="text-sm text-gray-900">{a.price || '—'}</p>
                  <div className="flex items-center gap-4 pt-1 text-sm">
                    <span className="text-gray-400">L'Express:</span>
                    <ListingLink url={a.lexpress} />
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-gray-400">Property Cloud:</span>
                    <ListingLink url={a.propertyCloud} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
