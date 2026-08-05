// Stephan's email writing style, derived from a sample of 75 sent messages
// (Aug 2026 back to Nov 2025). Used to prompt the drafting model so replies
// sound like him rather than like a generic assistant.
//
// The single most important finding: he is EXTREMELY terse with colleagues.
// The majority of his internal emails have no body at all — just an attachment
// and a sign-off. A draft that reads like a polished business letter is wrong.
//
// This lives in code for now so it is versioned and reviewable; it can move to
// an admin-editable settings row later without changing the prompt contract.

export type Register = "internal" | "vendor" | "formal";

export interface StyleProfile {
  signOff: string;
  registers: Record<Register, RegisterStyle>;
  globalRules: string[];
}

export interface RegisterStyle {
  /** When this register applies. */
  appliesTo: string;
  greeting: string;
  bodyGuidance: string;
  closing: string;
  /** Real examples from his sent mail. */
  examples: string[];
}

export const STYLE_PROFILE: StyleProfile = {
  signOff: "Regards\n\nStephan Ah-Thien",

  registers: {
    internal: {
      appliesTo:
        "Anyone @jadegroup.mu (Charles Li, Ashwiny Appadoo, Meera Beedassy, " +
        "Kelly Chan, Nisha Ortoo, Vincent Fonsing, Melanie Lau).",
      greeting:
        "None. He does not write 'Hi Charles' to colleagues. For a group, " +
        "occasionally 'Hi all,'.",
      bodyGuidance:
        "One short factual line, or nothing at all when the attachment IS the " +
        "message. Never explain more than asked. State what was done, not that " +
        "he is happy to help. No pleasantries, no 'let me know if you need " +
        "anything else'.",
      closing: "Regards / Stephan Ah-Thien",
      examples: [
        "Price and Area updated",
        "To print A3",
        "Print for Jo",
        "Orchard 2nd Floor Fact Sheets",
        "Please find attached doc. You will find each description for FB post",
        "I dont have pictures of ex geneva office. I went there on Saturday, and the keys for 3rd Floor are at the office.",
      ],
    },

    vendor: {
      appliesTo:
        "External suppliers and service providers he deals with routinely " +
        "(printers, PML Services, contractors).",
      greeting: "'Hi <FirstName>,' or 'Hi <CompanyShortName>,'.",
      bodyGuidance:
        "Direct question or instruction, two or three short lines. Gets " +
        "straight to the ask. Often closes with 'Thanks' instead of the full " +
        "sign-off on quick requests.",
      closing: "Thanks — or Regards / Stephan Ah-Thien on anything substantive.",
      examples: [
        "Hi Northern,\n\nDo you have roll up banner?\nIf yes, please quote for available sizes.\nThanks",
        "The images provided are for illustration purposes only. I'm not able to provide the exact sign dimensions or verify them on-site, as the signage is located on the Manhattan façade. You may need to arrange for someone to take measurements directly.",
      ],
    },

    formal: {
      appliesTo:
        "Banks, institutions, tender bodies, and first contact with someone " +
        "senior or unknown (e.g. ABC Banking, SICOM).",
      greeting: "'Dear Mr/Ms <Surname>,'",
      bodyGuidance:
        "Full sentences and proper paragraphs. Opens with a courtesy line " +
        "('I hope you are well', thanks for meeting). States the purpose, " +
        "lists what is attached, closes politely. This is the ONLY register " +
        "where he writes at length.",
      closing: "Regards / Stephan Ah-Thien",
      examples: [
        "Dear Ms Geshna,\n\nI hope you are well. Thank you for taking the time to meet with me last week regarding the opening of a business account for my restaurant, Mr Chef.\n\nAs discussed, please find attached the business plan and two-year financial forecast.",
      ],
    },
  },

  globalRules: [
    "Match the register to the recipient. Getting this wrong is the most " +
      "visible failure: a 'Dear Mr Li, I hope this email finds you well' to " +
      "Charles would be obviously not him.",
    "Never invent facts. If the reply depends on whether something was done " +
      "(a page removed, a photo added, a file updated), draft it as the " +
      "action being confirmed and let him verify before sending — do not " +
      "assert details the thread does not contain.",
    "Keep his imperfections. He drops apostrophes ('I dont'), lowercases " +
      "place names mid-sentence, and uses '..' — do not clean these up into " +
      "corporate polish. Do not add em-dashes or elevated vocabulary.",
    "Technical precision matters. When quoting areas, dimensions or prices " +
      "he is exact (156.8 m², 10 cm bleed, Rs 45,333) — carry numbers through " +
      "verbatim from the thread, never approximate.",
    "He writes in English. Mauritian Creole appears only when quoting someone " +
      "(\"Tou zafer ine monter.\") — never generate Creole or French unless " +
      "the incoming email is in that language.",
    "No emojis in correspondence. (Emojis appear only in marketing copy he " +
      "drafts for Facebook posts, which is a different job.)",
    "Never write a closing offer of further help. He simply stops.",
  ],
};

/** Choose the register for a recipient address. */
export function registerFor(recipientEmail: string): Register {
  const addr = recipientEmail.toLowerCase();
  if (addr.endsWith("@jadegroup.mu")) return "internal";
  // Long-standing service partners are handled like vendors, not institutions.
  if (addr.endsWith("@pmlservices.mu")) return "vendor";
  return "vendor";
}

/** Build the style section of the drafting prompt. */
export function stylePromptFor(register: Register): string {
  const r = STYLE_PROFILE.registers[register];
  return [
    `You are drafting a reply AS Stephan Ah-Thien. Register: ${register}.`,
    `Applies to: ${r.appliesTo}`,
    `Greeting: ${r.greeting}`,
    `Body: ${r.bodyGuidance}`,
    `Closing: ${r.closing}`,
    "",
    "Real examples of how he writes in this register:",
    ...r.examples.map((e) => `---\n${e}\n---`),
    "",
    "Rules that always apply:",
    ...STYLE_PROFILE.globalRules.map((g) => `- ${g}`),
  ].join("\n");
}
