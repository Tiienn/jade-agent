/**
 * Generate a readable password an admin can hand to a worker.
 * Avoids ambiguous characters (0/O, 1/l/I) and uses a length of 12.
 */
export function generatePassword(length = 12): string {
  const lowers = 'abcdefghijkmnpqrstuvwxyz' // no l
  const uppers = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I, O
  const digits = '23456789' // no 0, 1
  const all = lowers + uppers + digits

  const pick = (set: string) => set[Math.floor(Math.random() * set.length)]

  // Guarantee at least one of each class, then fill the rest.
  const chars = [pick(lowers), pick(uppers), pick(digits)]
  for (let i = chars.length; i < length; i++) chars.push(pick(all))

  // Fisher–Yates shuffle so the guaranteed chars are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
