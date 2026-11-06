import { z } from "zod";

/**
 * The AI Advisor's validation vocabulary.
 *
 * ── Why a separate file ──────────────────────────────────────────────────
 *
 * The commerce schemas are the customer-facing catalogue vocabulary. The
 * advisor schemas describe a different thing — a chat transcript, a
 * skin profile, a file upload — and they are validated at a different
 * boundary. Mixing them would blur the distinction.
 *
 * ── The rule about strings ───────────────────────────────────────────────
 *
 * Every string that reaches the database is trimmed and length-capped
 * here. A cap is not a nicety: an unbounded `notes` field is a place
 * to put a megabyte of text, and an unbounded `message` is a place to
 * put a prompt injection aimed at the model.
 */

/**
 * The maximum length of a chat message.
 *
 * 2000 characters is roughly 300 words — enough for a detailed skin
 * description, short enough that a prompt-injection payload does not
 * have much room.
 */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * The maximum length of a free-text note.
 */
export const MAX_NOTES_LENGTH = 4000;

/**
 * The maximum number of concerns a profile can carry.
 */
export const MAX_CONCERNS = 12;

/**
 * The static catalogue of skin concerns.
 *
 * ── Why a closed list ────────────────────────────────────────────────────
 *
 * A concern is a **label**, not free text. It is used to filter the
 * catalogue, to match against the conflict engine's ingredient tags, and
 * to group reviews. All three need a shared vocabulary — "dullness" and
 * "dull" and "looking dull" must resolve to the same thing, or the filter
 * silently returns nothing.
 *
 * Free text would also let a customer store an unbounded string in a
 * column that other code queries with an `in` filter. A closed list makes
 * the vocabulary explicit, and a concern that is not on the list is a
 * validation error rather than a row nothing can ever match.
 */
export const SKIN_CONCERNS = [
  "ACNE",
  "BLACKHEADS",
  "DULLNESS",
  "DRYNESS",
  "FINE_LINES",
  "OILINESS",
  "PORE_SIZE",
  "REDNESS",
  "SENSITIVITY",
  "DARK_SPOTS",
  "UNEVEN_TONE",
  "DEHYDRATION",
] as const;

/**
 * A concern drawn from the static catalogue.
 */
export const skinConcernSchema = z.enum(SKIN_CONCERNS);

/**
 * The concerns list, constrained to the catalogue.
 *
 * The count is capped at `MAX_CONCERNS` as well as being drawn from a
 * closed list — a customer can pick twelve of the twelve, which is
 * already unusual, and more than that is not a profile.
 */
export const catalogueConcernsSchema = z
  .array(skinConcernSchema)
  .max(MAX_CONCERNS, "That is a lot of concerns — pick the ones that matter most.")
  .default([]);

/**
 * The maximum length of a single concern.
 */
export const MAX_CONCERN_LENGTH = 60;

/**
 * The maximum number of conversations returned by the list endpoint.
 */
export const MAX_CONVERSATION_LIMIT = 50;

/**
 * The maximum number of advisor messages per hour, per user.
 *
 * The advisor is a paid call to a model provider. Without a cap, one
 * script could exhaust the quota for every customer.
 */
export const MAX_MESSAGES_PER_HOUR = 20;

/**
 * The chat message.
 *
 * A message is optional **only if** an image accompanies it. That
 * constraint cannot be expressed in a single object schema, so it is
 * checked at the route level — see `assertMessageOrImage`.
 */
export const advisorMessageSchema = z
  .string()
  .trim()
  .max(MAX_MESSAGE_LENGTH, "Your message is too long.")
  .min(1, "Your message cannot be empty.");

/**
 * The conversation id supplied by the client.
 *
 * Optional — when it is absent, a conversation is created.
 */
export const advisorConversationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .optional();

/**
 * The maximum number of prior turns the client may send.
 *
 * The same cap the service layer applies to the turns it reads from the
 * database, so a client cannot make the prompt larger than the server
 * would have allowed. Twenty turns is ten exchanges.
 */
export const MAX_CLIENT_HISTORY_TURNS = 20;

/**
 * One prior turn, as sent by the client.
 *
 * The shape matches the `AdvisorHistoryTurn` the service layer builds
 * from the database, so the two can be merged without a translation
 * step.
 */
export const advisorHistoryTurnSchema = z.object({
  role: z.enum(["USER", "ASSISTANT"]),
  content: z
    .string()
    .trim()
    .min(1, "A history turn cannot be empty.")
    .max(MAX_MESSAGE_LENGTH, "A history turn is too long."),
});

/**
 * The conversation history the client sends alongside its message.
 *
 * ── Why the client sends it at all ───────────────────────────────────────
 *
 * The server can read the conversation's turns from the database, and
 * usually does. But the client knows exactly what has been said in the
 * conversation the customer is *looking at*, and it knows it
 * immediately — whereas a database read is a round trip and can be
 * behind by a turn.
 *
 * So the client sends its transcript and the server merges the two. The
 * merge is deliberately conservative: the stored transcript wins unless
 * the client's is demonstrably *ahead* of it. See `mergeHistory` in
 * `src/lib/ai/service.ts`.
 *
 * The schema is strict about the shape and the caps, because this is
 * untrusted input on its way to a prompt.
 */
export const advisorHistorySchema = z
  .array(advisorHistoryTurnSchema)
  .max(MAX_CLIENT_HISTORY_TURNS);

/**
 * The `saveAsProfilePhoto` flag.
 */
export const saveAsProfilePhotoSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

/**
 * The skin type.
 *
 * The values are the Prisma `SkinType` enum, listed explicitly so an
 * unknown value is a validation error rather than a database error.
 *
 * The list must match the enum exactly. A value that is valid in the
 * schema but absent from the enum would reach the database and fail
 * there, with a much worse error message.
 */
export const skinTypeSchema = z.enum([
  "NORMAL",
  "DRY",
  "OILY",
  "COMBINATION",
  "SENSITIVE",
  "ACNE_PRONE",
  "UNKNOWN",
]);

/**
 * A single concern.
 */
export const concernSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CONCERN_LENGTH);

/**
 * The concerns list.
 */
export const concernsSchema = z
  .array(concernSchema)
  .max(MAX_CONCERNS, "That is a lot of concerns — pick the ones that matter most.")
  .default([]);

/**
 * The profile notes.
 */
export const profileNotesSchema = z
  .string()
  .trim()
  .max(MAX_NOTES_LENGTH, "Your notes are too long.")
  .nullable()
  .optional();

/**
 * The profile update body.
 *
 * `estimatedEmptyAt` must be a **future** date. A reminder for a product
 * that already ran out is not a reminder, and accepting a past date would
 * put the row permanently in the past — where the sweep would either
 * ignore it forever or, worse, fire it immediately and repeatedly.
 */
export const updateProfileSchema = z.object({
  skinType: skinTypeSchema.nullable().optional(),
  concerns: catalogueConcernsSchema.optional(),
  notes: profileNotesSchema,
  estimatedEmptyAt: z
    .string()
    .trim()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .refine(
      (value) => value === null || value === undefined || new Date(value).getTime() > Date.now(),
      { message: "The estimated empty date must be in the future." },
    ),
  smsOptIn: z.boolean().optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * The conversation list query.
 */
export const conversationListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CONVERSATION_LIMIT)
    .default(20),
});

export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

/**
 * The admin disclaimer update body.
 */
export const updateAdvisorConfigSchema = z.object({
  disclaimerText: z
    .string()
    .trim()
    .min(1, "The disclaimer cannot be empty.")
    .max(2000, "The disclaimer is too long."),
  systemPrompt: z.string().trim().max(8000).nullable().optional(),
  aiProductIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  enforceCartConflicts: z.boolean().optional(),
});

export type UpdateAdvisorConfigInput = z.infer<typeof updateAdvisorConfigSchema>;

/**
 * The admin advisor-message query.
 *
 * Filters are all optional and all *rejected* when invalid — a filter
 * that does not parse is an error, not something to silently ignore. A
 * silently-dropped filter would show the admin a list of everything and
 * let them believe it was filtered.
 */
export const adminAdvisorMessagesQuerySchema = z.object({
  conversationId: z.string().trim().min(1).max(64).optional(),
  userId: z.string().trim().min(1).max(64).optional(),
  /**
   * `true` for mocked messages only, `false` for real-provider messages
   * only, omitted for both.
   */
  isMocked: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  /** Inclusive lower bound on `createdAt`. */
  from: z
    .string()
    .trim()
    .datetime({ offset: true })
    .optional(),
  /** Inclusive upper bound on `createdAt`. */
  to: z
    .string()
    .trim()
    .datetime({ offset: true })
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type AdminAdvisorMessagesQuery = z.infer<
  typeof adminAdvisorMessagesQuerySchema
>;

/**
 * The image MIME types the advisor accepts.
 *
 * The list is narrow on purpose. A chat attachment is a photo of
 * somebody's face; there is no reason to accept a PDF or a video here.
 */
export const ADVISOR_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/**
 * The maximum size of an uploaded image.
 *
 * 5 MB. Enforced by the upload validator, which also checks the magic
 * bytes — a client can lie about `Content-Type` but not about the
 * file's actual header.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The maximum size of a profile photo.
 *
 * The same cap as a chat attachment, and for the same reason: a
 * profile photo is no larger a thing than a chat attachment, and a
 * second, different cap would be a second number to keep in step.
 */
export const PROFILE_PHOTO_MAX_BYTES = MAX_IMAGE_BYTES;
