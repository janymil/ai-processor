/**
 * SECOND LAYER ONLY. This file mirrors Kaptia's `shared/aiAnonymizer.ts` (copied so the
 * gateway stays self-contained and usable by any app). The calling app is expected to
 * anonymise first; the gateway runs these same rules again on every chat message as a
 * safety net, so a caller that forgets still cannot leak identifiers upstream.
 * Keep the rules in sync with the Kaptia file when they change.
 *
 * Everything that leaves this server for an AI model passes through here first.
 *
 *   anonymizeText()  -> text (and how many of each identifier were removed)
 *   anonymizeDeep()  -> the same for a whole request payload
 *
 * Removed: e-mails, IBANs, card numbers (Luhn-checked so amounts are never touched),
 * national IDs (SK birth number, ES DNI/NIE, PE RUC, US SSN), phones, postal addresses,
 * URLs, bank account numbers, and the signed-in user's own name/e-mail.
 *
 * Kept on purpose: merchant names, amounts, dates, categories and identifier-free text —
 * the model needs those to be useful.
 */

export type RedactionCounts = Record<string, number>;

export interface AnonymizeResult {
  text: string;
  redactions: RedactionCounts;
}

export interface AnonymizeExtras {
  /** The signed-in user's name parts and e-mail — removed verbatim if present. */
  names?: Array<string | null | undefined>;
  email?: string | null;
}

function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (Number.isNaN(value)) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function count(counts: RedactionCounts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

interface Rule {
  name: string;
  pattern: RegExp;
  replacement: string;
  /** Optional guard: return false to leave the match alone. */
  accept?: (match: string) => boolean;
}

const RULES: Rule[] = [
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[email]',
  },
  {
    // IBAN: two letters, two digits, then 11–30 alphanumerics, optionally grouped in fours.
    name: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{0,4}\b/g,
    replacement: '[iban]',
  },
  {
    name: 'card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    replacement: '[card]',
    accept: (match) => luhnValid(match.replace(/[^0-9]/g, '')),
  },
  {
    // "Account holder: Ján Novák", "Cliente: Juan Pérez", "Majiteľ účtu: ..."
    name: 'account_holder',
    pattern:
      /((?:account\s*holder|holder\s*name|card\s*holder|majite[ľl]\s*účtu|držite[ľl]\s*karty|titular|nombre\s*del\s*titular|titulaire|cliente|customer|nombre|bill\s*to|ship\s*to|attn|z[áa]kazn[íi]k)[^\S\n]*[:=][^\S\n]*)([^,;\n]{2,60})/gi,
    replacement: '$1[person]',
  },
  {
    // Peruvian/Spanish document numbers: "DNI: 12345678", "C.E. 001234567".
    name: 'labelled_document',
    pattern: /\b((?:DNI|C\.?E\.?|documento|doc\.?)[^\S\n]*[:#]?[^\S\n]*)\d{6,9}[A-Za-z]?\b/gi,
    replacement: '$1[national-id]',
  },
  {
    // Masked card numbers: "**** 4321", "•••• 1234".
    name: 'card',
    pattern: /(?:\*{2,}|•{2,}|x{2,})[ ]?\d{4}\b/gi,
    replacement: '[card]',
  },
  {
    name: 'sk_birth_number',
    pattern: /\b\d{6}\s?\/\s?\d{3,4}\b/g,
    replacement: '[national-id]',
  },
  {
    name: 'es_dni_nie',
    pattern: /\b(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/g,
    replacement: '[national-id]',
  },
  {
    name: 'pe_ruc',
    pattern: /\b(?:10|15|17|20)\d{9}\b/g,
    replacement: '[tax-id]',
  },
  {
    name: 'us_ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[national-id]',
  },
  {
    // International phone numbers: require a leading + or at least 9 digits, and never
    // match inside a longer digit run (that is an account number, handled below).
    name: 'phone',
    pattern: /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3}[\s.-]?\d{3,4}(?!\d)/g,
    replacement: '[phone]',
    accept: (match) => match.replace(/\D/g, '').length >= 9,
  },
  {
    // Street-first addresses: "ul. Mlynské nivy 5", "Calle Los Olivos 123".
    name: 'address',
    pattern:
      /\b(?:ul\.?|ulica|trieda|nám\.?|námestie|calle|avenida|av\.?|jir[oó]n|pasaje|urbanizaci[oó]n)\s+[^\n,;]{2,40}?\s+\d{1,4}[a-zA-Z]?\b/gi,
    replacement: '[address]',
  },
  {
    name: 'address',
    pattern:
      /\b\d{1,4}[a-zA-Z]?\s+[A-Za-zÀ-ž][\wÀ-ž'.-]*(?:\s+[A-Za-zÀ-ž][\wÀ-ž'.-]*){0,3}\s+(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|way|ulica|ul\.?|trieda|námestie|nám\.?|calle|avenida|av\.?|jir[oó]n|pasaje|urbanizaci[oó]n)\b\.?/gi,
    replacement: '[address]',
  },
  {
    name: 'url',
    pattern: /\bhttps?:\/\/[^\s<>"']+/gi,
    replacement: '[url]',
  },
  {
    // Long digit runs are account/reference numbers, never amounts (amounts are shorter
    // and carry decimals).
    name: 'account_number',
    pattern: /\b\d{10,20}\b/g,
    replacement: '[account]',
  },
];


/** Names/e-mails supplied by the caller are removed as whole words, case-insensitively. */
function removeExtras(text: string, extras: AnonymizeExtras | undefined, counts: RedactionCounts): string {
  if (!extras) return text;
  let result = text;

  const values = new Set<string>();
  for (const name of extras.names ?? []) {
    const value = (name ?? '').trim();
    if (value.length >= 3) {
      values.add(value);
      for (const part of value.split(/\s+/)) {
        if (part.length >= 3) values.add(part);
      }
    }
  }
  if (extras.email && extras.email.includes('@')) values.add(extras.email.trim());

  for (const value of Array.from(values)) {
    const pattern = new RegExp(`\\b${escapeRegExp(value)}\\b`, 'gi');
    if (pattern.test(result)) {
      result = result.replace(pattern, '[removed]');
      count(counts, 'personal');
    }
  }
  return result;
}

/** Anonymises one string. Idempotent: running it twice changes nothing further. */
export function anonymizeText(input: string, extras?: AnonymizeExtras): AnonymizeResult {
  const counts: RedactionCounts = {};
  if (!input || typeof input !== 'string') return { text: input ?? '', redactions: counts };

  let text = input;

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      if (rule.accept && !rule.accept(match)) return match;

      // Rules with a capture group keep their prefix (e.g. "Account holder: ").
      if (rule.replacement.includes('$1')) {
        const groups = rest.slice(0, -2) as string[];
        count(counts, rule.name);
        return rule.replacement.replace('$1', groups[0] ?? '');
      }

      count(counts, rule.name);
      return rule.replacement;
    });
  }

  text = removeExtras(text, extras, counts);

  return { text, redactions: counts };
}

/**
 * Anonymises every string inside a request payload (objects, arrays, nested).
 * Account identifiers are dropped entirely, not just replaced.
 */
export function anonymizeDeep<T>(value: T, extras?: AnonymizeExtras): { value: T; redactions: RedactionCounts } {
  const counts: RedactionCounts = {};

  const walk = (input: unknown, depth = 0): unknown => {
    if (depth > 12) return input;
    if (typeof input === 'string') {
      const result = anonymizeText(input, extras);
      for (const [key, amount] of Object.entries(result.redactions)) {
        counts[key] = (counts[key] ?? 0) + amount;
      }
      return result.text;
    }
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));
    if (input && typeof input === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        // Account identifiers never travel to a model.
        if (/^(userId|user_id|email|userEmail|accountId|account_id)$/i.test(key)) continue;
        output[key] = walk(item, depth + 1);
      }
      return output;
    }
    return input;
  };

  return { value: walk(value) as T, redactions: counts };
}

/** Does this text contain anything that must be removed before an AI call? */
export function containsIdentifiers(text: string): boolean {
  return Object.keys(anonymizeText(text).redactions).length > 0;
}

/**
 * Chat messages in the shape every provider accepts. String content is scrubbed; so are
 * the `text` parts of multimodal content (images themselves are never sent by Kaptia —
 * receipts are read locally).
 */
export function anonymizeMessages<T extends Array<{ role: string; content: unknown }>>(
  messages: T,
  extras?: AnonymizeExtras,
): T {
  return messages.map((message) => {
    if (typeof message.content === 'string') {
      return { ...message, content: anonymizeText(message.content, extras).text };
    }
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part: any) =>
          part && typeof part === 'object' && typeof part.text === 'string'
            ? { ...part, text: anonymizeText(part.text, extras).text }
            : part,
        ),
      };
    }
    return message;
  }) as T;
}

