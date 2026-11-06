/**
 * Reading a failed form's field errors off an API envelope.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * When a request fails validation, the API does not return a bare
 * "something was wrong". It returns the envelope's `error.details`,
 * which carries a `fieldErrors` map — a field path to the messages for
 * that field:
 *
 * ```json
 * {
 *   "ok": false,
 *   "error": {
 *     "code": "VALIDATION_ERROR",
 *     "message": "The request failed validation.",
 *     "details": {
 *       "fieldErrors": {
 *         "name": ["The product needs a name."],
 *         "climateTips": ["That climate tip is too long."]
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * That map is the **only** thing that says which field was wrong. The
 * `message` is deliberately generic — "The request failed validation." —
 * because the server cannot know which of a dozen fields the admin
 * filled in wrongly, and a message that guessed would be worse than one
 * that admitted it.
 *
 * So a client that renders only `error.message` throws away the
 * information it was given, and the admin is told their form is invalid
 * without being told **what** to fix. That is the bug this module
 * exists to prevent.
 *
 * ── Why the reading is defensive ──────────────────────────────────────────
 *
 * `details` is `Record<string, unknown>` — the envelope is a wire
 * format, and anything can arrive. So this reader:
 *
 *   - accepts a missing `details`, a missing `fieldErrors`, or a
 *     `fieldErrors` of the wrong shape, and returns an empty map rather
 *     than throwing;
 *   - flattens a field's messages to **one** string, because a form
 *     renders one message under an input, not a list;
 *   - keeps the **first** message, because it is the most specific one
 *     — Zod reports the type error before the range error, and "expected
 *     string, received null" is more useful than "expected string".
 *
 * ── Client-safe ───────────────────────────────────────────────────────────
 *
 * This module imports nothing, so a `"use client"` component can use it
 * without pulling the server's validation layer into the browser bundle.
 */

/**
 * The field errors of a failed request, as one message per field.
 */
export type FieldErrors = Record<string, string>;

/**
 * The shape of a failure's `details`.
 */
type FailureDetails = {
  readonly fieldErrors?: unknown;
};

/**
 * The message shown when a field has an error but no readable one.
 *
 * Never blank: an empty error box is worse than a vague one, because it
 * tells the admin the field is wrong without saying anything about it.
 */
const GENERIC_FIELD_MESSAGE = "This value is not valid.";

/**
 * Reads the field errors out of a failed API envelope.
 *
 * @param error - The envelope's `error` object, or `null`/`undefined`
 *                when the request failed before it produced one.
 *
 * @returns A map of field path to a single message. Empty when the
 *          failure carried no field errors — a network failure, a
 *          conflict, a 500.
 */
export function readFieldErrors(error: unknown): FieldErrors {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const details = (error as { details?: unknown }).details;

  if (typeof details !== "object" || details === null) {
    return {};
  }

  const fieldErrors = (details as FailureDetails).fieldErrors;

  if (typeof fieldErrors !== "object" || fieldErrors === null) {
    return {};
  }

  const result: FieldErrors = {};

  for (const [path, messages] of Object.entries(
    fieldErrors as Record<string, unknown>,
  )) {
    /**
     * A field's messages are an **array**.
     *
     * A single message — a string where an array was expected — is
     * accepted too, because a hand-written or legacy error body should
     * not leave the admin staring at a blank form.
     */
    const first =
      Array.isArray(messages)
        ? messages[0]
        : typeof messages === "string"
          ? messages
          : undefined;

    const message =
      typeof first === "string" && first.length > 0
        ? first
        : Array.isArray(messages) && messages.length > 0
          ? GENERIC_FIELD_MESSAGE
          : null;

    if (message === null) continue;

    /**
     * The **field**, not the path.
     *
     * A problem inside an array is reported by Zod with an indexed path
     * — `images.0`, `badges.2` — because the offending *element* is
     * what is wrong. But a form renders one message per **field**: the
     * admin did not type "images.0", they picked three images.
     *
     * So an indexed path is folded back onto the field that holds it.
     * Without this, the message would be filed under a key the form
     * has no input for, and the admin would see a form that says
     * nothing about the image they added.
     *
     * The first message for a field wins, because it is the most
     * specific one.
     */
    const field = fieldForPath(path);

    if (result[field] === undefined) {
      result[field] = message;
    }
  }

  return result;
}

/**
 * The field an error path belongs to.
 *
 * `name` → `name`. `images.0` → `images`. `images.0.alt` → `images`.
 *
 * The **first** segment is the field, always. A form has one input per
 * field; a nested path describes the same field as its root, and
 * splitting a nested path across several keys would only mean some of
 * them had nowhere to render.
 */
function fieldForPath(path: string): string {
  const root = path.split(".")[0];

  return root.length > 0 ? root : path;
}

/**
 * The message shown when a form fails but no single field is to blame.
 *
 * Used for the failure that is genuinely about the whole submission —
 * a conflict, a network error, a server fault — so the admin still gets
 * something to read.
 */
export function readErrorMessage(
  error: unknown,
  fallback = "We could not save that. Please try again.",
): string {
  if (typeof error !== "object" || error === null) {
    return fallback;
  }

  const message = (error as { message?: unknown }).message;

  return typeof message === "string" && message.length > 0
    ? message
    : fallback;
}
