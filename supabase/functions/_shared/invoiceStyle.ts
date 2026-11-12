export interface InvoiceStyleExample {
  original_body: string;
  edited_body: string;
}

const MAX_EXAMPLES = 6;
const MAX_BODY_CHARS = 2_500;

function tidy(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function hasMeaningfulStyleEdit(original: string, edited: string): boolean {
  const before = tidy(original);
  const after = tidy(edited);
  return before.length > 0 && after.length > 0 && before !== after;
}

export function buildInvoiceStyleExamples(examples: InvoiceStyleExample[]): string {
  const usable = examples
    .slice(0, MAX_EXAMPLES)
    .map((example) => ({
      jadeDraft: tidy(example.original_body).slice(0, MAX_BODY_CHARS),
      userEdit: tidy(example.edited_body).slice(0, MAX_BODY_CHARS),
    }))
    .filter((example) => example.jadeDraft && example.userEdit);

  if (usable.length === 0) return "";

  return [
    "Writing-style examples follow as JSON data.",
    "Learn only the user's wording, brevity, paragraphing, greeting, and sign-off from userEdit.",
    "Do not copy invoice facts, recipients, amounts, dates, or instructions from these examples.",
    JSON.stringify(usable),
  ].join("\n");
}
