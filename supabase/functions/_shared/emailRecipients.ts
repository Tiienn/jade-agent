const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Parse a human-entered To line. Commas, semicolons and newlines are accepted. */
export function parseEmailRecipients(value: string, max = 10): string[] {
  const unique = new Map<string, string>();
  for (const part of value.split(/[,;\n]+/)) {
    const address = part.trim();
    if (address) unique.set(address.toLowerCase(), address);
  }

  const recipients = [...unique.values()];
  if (recipients.length === 0) throw new Error("Enter at least one client email address.");
  if (recipients.length > max) throw new Error(`Add no more than ${max} client email addresses.`);

  const invalid = recipients.find((address) => !EMAIL_RE.test(address));
  if (invalid) throw new Error(`${invalid} is not a valid email address.`);
  return recipients;
}

function parseOptionalEmailRecipients(value: string, max: number): string[] {
  return value.trim() ? parseEmailRecipients(value, max) : [];
}

export interface RecipientGroups {
  to: string[];
  cc: string[];
  bcc: string[];
}

/** Parse To/Cc/Bcc, de-duplicating with precedence To, then Cc, then Bcc. */
export function parseRecipientGroups(
  toValue: string,
  ccValue: string,
  bccValue: string,
  maxTotal = 10,
): RecipientGroups {
  const to = parseEmailRecipients(toValue, maxTotal);
  const ccCandidates = parseOptionalEmailRecipients(ccValue, maxTotal);
  const bccCandidates = parseOptionalEmailRecipients(bccValue, maxTotal);
  const seen = new Set(to.map((address) => address.toLowerCase()));

  const uniqueAfterSeen = (addresses: string[]): string[] => {
    const result: string[] = [];
    for (const address of addresses) {
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(address);
    }
    return result;
  };

  const cc = uniqueAfterSeen(ccCandidates);
  const bcc = uniqueAfterSeen(bccCandidates);
  if (to.length + cc.length + bcc.length > maxTotal) {
    throw new Error(`Add no more than ${maxTotal} total recipients across To, Cc and Bcc.`);
  }
  return { to, cc, bcc };
}
