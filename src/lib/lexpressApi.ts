import { FUNCTIONS_BASE, authHeaders, parseJsonError } from './api'

export interface LexpressStatus {
  enabled: boolean
  credentialsConfigured: boolean
  recipient: string
  mailboxEmail: string | null
  baselineAt: string | null
  lastCheckedAt: string | null
  lastSuccessAt: string | null
  lastSentAt: string | null
  lastDeliveryStatus: 'accepted' | 'confirmed' | null
  lastSentWebLink: string | null
  lastError: string | null
  knownLeads: number
}

export interface LexpressRunResult {
  checked: number
  new: number
  sent: number
  recipient: string
  deliveryStatus: 'accepted' | 'confirmed' | null
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}/lexpress-monitor`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseJsonError(res, "Could not update the L'Express monitor.")
  return (await res.json()) as T
}

export function lexpressStatus(): Promise<LexpressStatus> {
  return post({ action: 'status' })
}

export function configureLexpress(email: string, password: string) {
  return post<{ configured: true; enabled: true; baselined: number; recipient: string }>({
    action: 'configure',
    email,
    password,
  })
}

export function setLexpressEnabled(enabled: boolean) {
  return post<{ enabled: boolean }>({ action: 'setEnabled', enabled })
}

export function runLexpressMonitor(): Promise<LexpressRunResult> {
  return post({ action: 'run' })
}
