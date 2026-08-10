import { useState } from 'react'
import { Copy, Check, RefreshCw } from 'lucide-react'
import { generatePassword } from '../../lib/password'

/**
 * Password input with generate + copy, as used everywhere an admin hands a
 * password to somebody: adding a worker, resetting a password, and creating a
 * login from the staff roster.
 *
 * The value is deliberately shown in clear text — the admin has to read it out
 * or paste it to the person — but it is only ever held by the form that owns
 * it, and that form drops it as soon as it is submitted. Nothing here logs it.
 */
export default function PasswordField({
  value,
  onChange,
  id,
}: {
  value: string
  onChange: (v: string) => void
  /** Ties an external <label> to the input. */
  id?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable — the admin can select the text manually.
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="At least 8 characters"
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 font-mono text-sm outline-none transition focus:border-jade-600 focus:ring-2 focus:ring-jade-600/20"
        />
        {value && (
          <button
            type="button"
            onClick={copy}
            className="inline-flex min-h-[44px] w-11 shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 transition-colors hover:bg-gray-50"
            aria-label="Copy password"
            title="Copy"
          >
            {copied ? (
              <Check size={16} className="text-jade-600" />
            ) : (
              <Copy size={16} />
            )}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(generatePassword())}
        className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-jade-700 hover:text-jade-800"
      >
        <RefreshCw size={14} />
        Generate a password
      </button>
    </div>
  )
}
