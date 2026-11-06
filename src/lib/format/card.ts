/**
 * Card formatting and validation for the browser.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The checkout's card panel needs four things: brand detection, input
 * formatting, and validation. All four are **pure arithmetic on strings**,
 * which makes them a formatting concern rather than a validation concern —
 * so they live here, in `src/lib/format/`, and not in
 * `src/lib/validation/`.
 *
 * The distinction matters because of what those two directories are for:
 *
 *   • `src/lib/validation/` holds the **Zod schemas that define what may
 *     reach the server**. Every file in it imports Zod.
 *
 *   • `src/lib/format/` holds **pure presentation helpers**. Seven of its
 *     nine modules import nothing at all, precisely so a client component
 *     can use them without dragging Zod into the browser bundle.
 *
 * A card number never reaches the server — see the note at the bottom of
 * this file — so it has no business in the validation layer, and the
 * validation layer would be the wrong place to keep a form from being
 * merely tedious.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **Nothing here decides whether a payment is valid. It only decides
 * whether the card the customer typed looks like a card.**
 *
 * The real authorisation is the gateway's, and the gateway is a server-side
 * sandbox. These functions exist so the customer gets immediate, specific
 * feedback while typing — "that card number fails the checksum" is a far
 * better experience than a silent rejection at the payment window.
 *
 * This module is **client-safe**: it imports nothing, and it holds no
 * server-only code.
 */

/**
 * The card networks the panel recognises.
 *
 * `"unknown"` is a real answer, not a fallback for a bug: a card from a
 * network this shop has not heard of is a perfectly ordinary thing to
 * type, and the panel must render it without claiming to know what it is.
 */
export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "unknown";

/**
 * The display name for a brand.
 *
 * The customer reads *"Visa"* and *"Mastercard"*, not the internal keys.
 */
const BRAND_LABELS: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  unknown: "Card",
};

/**
 * The human-readable name for a card brand.
 */
export function cardBrandLabel(brand: CardBrand): string {
  return BRAND_LABELS[brand];
}

/**
 * The number of digits a card of each brand carries.
 *
 * Amex is the odd one out — 15 digits rather than 16, and a 4-digit CVC
 * rather than 3. Getting that wrong means rejecting a valid card, so it
 * is stated here rather than assumed to be 16.
 */
const BRAND_LENGTHS: Record<CardBrand, readonly number[]> = {
  visa: [16, 19],
  mastercard: [16, 19],
  amex: [15],
  discover: [16, 19],
  unknown: [13, 19],
};

/**
 * The number of CVC digits a card of each brand carries.
 */
const BRAND_CVC_LENGTHS: Record<CardBrand, number> = {
  visa: 3,
  mastercard: 3,
  amex: 4,
  discover: 3,
  unknown: 3,
};

/**
 * The maximum number of digits a card number may carry.
 *
 * 19 is the longest number in circulation (Visa and Mastercard both allow
 * it), so nothing longer can be real and the field stops there.
 */
const MAX_CARD_DIGITS = 19;

/**
 * Detects the card network from the leading digits.
 *
 * The issuer identification number is the first few digits of the PAN, and
 * each network owns a range of them:
 *
 *   • **Visa** — starts with `4`.
 *   • **Mastercard** — `51`–`55`, plus the `2221`–`2720` range the
 *     network added later.
 *   • **American Express** — `34` or `37`.
 *   • **Discover** — `6011`, `65`, or `644`–`649`.
 *
 * An unrecognised prefix is `"unknown"`, and the panel says *"Card"* rather
 * than guessing. A wrong guess is worse than no answer: the customer would
 * be told their card is a Mastercard and then told the CVC is three digits
 * when it needs four.
 *
 * @param value - The card number, with or without spaces.
 */
export function detectCardBrand(value: string): CardBrand {
  const digits = value.replace(/\D/g, "");

  if (digits.length === 0) {
    return "unknown";
  }

  // Visa.
  if (digits.startsWith("4")) {
    return "visa";
  }

  // Mastercard — the original 51–55 range.
  if (/^5[1-5]/.test(digits)) {
    return "mastercard";
  }

  // Mastercard — the 2221–2720 range.
  if (/^2[2-7]/.test(digits)) {
    const firstFour = Number.parseInt(digits.slice(0, 4), 10);

    if (firstFour >= 2221 && firstFour <= 2720) {
      return "mastercard";
    }
  }

  // American Express.
  if (/^3[47]/.test(digits)) {
    return "amex";
  }

  // Discover.
  if (/^6(?:011|5)/.test(digits)) {
    return "discover";
  }

  if (/^6(?:4[4-9])/.test(digits)) {
    return "discover";
  }

  return "unknown";
}

/**
 * Formats a card number into groups of four.
 *
 * The customer types digits; the field shows `4242 4242 4242 4242`. Any
 * non-digit the customer pasted — a dash, a space — is dropped rather than
 * fought with, because a card number is digits and the separators are a
 * display convention.
 *
 * The result is capped at 19 digits, so a pasted paragraph cannot produce
 * an unbounded string.
 */
export function formatCardNumber(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, MAX_CARD_DIGITS);

  return digits.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Formats an expiry as `MM/YY`.
 *
 * The separator is inserted as soon as the customer has typed two digits,
 * so they do not have to think about where it goes. The result is capped
 * at five characters, and the year is two digits — the form every card
 * carries.
 */
export function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);

  if (digits.length <= 2) {
    return digits;
  }

  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

/**
 * Formats a CVC.
 *
 * Digits only, capped at four — four is the Amex length, and a shorter
 * cap would truncate a valid Amex code.
 */
export function formatCvc(value: string): string {
  return value.replace(/\D/g, "").slice(0, 4);
}

/**
 * The Luhn checksum.
 *
 * The industry checksum for card numbers: every second digit from the
 * right is doubled, and the digits of each product are summed together
 * with the untouched digits. The total is divisible by ten **if and only
 * if** the number is well-formed.
 *
 * This is the check that makes the card number field a real card field.
 * Without it, `4242 4242 4242 4241` would be accepted — it has the right
 * shape and the right length, and it is not a card number at all.
 *
 * @param digits - The number's digits, with no separators.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const character = digits[index];
    if (character === undefined) return false;

    let digit = character.charCodeAt(0) - 48;

    if (double) {
      digit *= 2;

      // A doubled digit above 9 contributes its two digits separately.
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

/**
 * Whether a card number is well-formed.
 *
 * Three conditions, all of them necessary:
 *
 *   1. The length is one the brand allows.
 *   2. The number passes the Luhn checksum.
 *   3. Every character is a digit.
 *
 * @param value - The card number, with or without separators.
 */
export function isValidCardNumber(value: string): boolean {
  const digits = value.replace(/\D/g, "");

  if (digits.length === 0 || /[^0-9\s-]/.test(value)) {
    return false;
  }

  const brand = detectCardBrand(digits);
  const allowed = BRAND_LENGTHS[brand];

  if (!allowed.includes(digits.length)) {
    return false;
  }

  return passesLuhn(digits);
}

/**
 * Whether an expiry is well-formed and in the future.
 *
 * The month must be a real month (01–12), and the card must not have
 * expired. The comparison is against the **current month, inclusive** — a
 * card whose expiry is this month is still valid until the end of it.
 *
 * @param value - The expiry, as `MM` or `MM/YY`.
 * @param now - The current date. Injectable so the rule can be tested
 *        without depending on the day the suite runs.
 */
export function isValidExpiry(value: string, now: Date = new Date()): boolean {
  const digits = value.replace(/\D/g, "");

  if (digits.length !== 4) {
    return false;
  }

  const month = Number.parseInt(digits.slice(0, 2), 10);
  const year = Number.parseInt(digits.slice(2), 10);

  if (month < 1 || month > 12) {
    return false;
  }

  // Two-digit years: 00–99 mean 2000–2099.
  const fullYear = 2000 + year;

  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  if (fullYear < currentYear) {
    return false;
  }

  if (fullYear === currentYear && month < currentMonth) {
    return false;
  }

  return true;
}

/**
 * Whether a CVC is well-formed.
 *
 * Three digits for most brands; four for American Express. The brand is a
 * parameter because the length genuinely differs — a three-digit Amex code
 * is a typo, and a four-digit Visa code is a typo.
 *
 * @param value - The CVC.
 * @param brand - The detected brand.
 */
export function isValidCvc(value: string, brand: CardBrand = "unknown"): boolean {
  const digits = value.replace(/\D/g, "");

  if (!/^\d*$/.test(value.replace(/\s/g, ""))) {
    return false;
  }

  if (digits.length !== BRAND_CVC_LENGTHS[brand]) {
    return false;
  }

  return true;
}

/**
 * Whether a card holder name is well-formed.
 *
 * Letters, spaces, hyphens and apostrophes — the characters that actually
 * appear on a card. A name is not a free-text field, so punctuation that
 * cannot appear on a printed card is refused.
 */
export function isValidCardHolder(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.length < 2 || trimmed.length > 100) {
    return false;
  }

  return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]*$/.test(trimmed);
}

/**
 * ── Why the card details are formatted here but never stored ────────────
 *
 * The card panel exists so the checkout reads like a real gateway. The
 * details it collects are **never sent to the server and never stored**:
 *
 *   • The values live in React state and are never given a `name`
 *     attribute, so they are not part of the form's `FormData`.
 *
 *   • The checkout request body is assembled from an explicit allow-list
 *     that does not mention them.
 *
 *   • `checkoutSchema` **refuses** them outright, so a leak would be a
 *     `400` rather than a silent strip — the guarantee is enforced at the
 *     boundary, where it cannot be forgotten.
 *
 * A shop that stores a card number is a shop that has breached PCI DSS.
 * This shop stores the payment *method* and the gateway's own reference,
 * and nothing else.
 */
