/**
 * POST a feedback submission to LiteLLM `/gpd/feedback`.
 *
 * One submission = one row in the server-side `gpd_feedback` table. The
 * server derives user_id, token_hash_suffix, client_ip, and user_agent
 * from the request — the client supplies only the category, message,
 * and (optionally) app_version.
 *
 * Throws on any non-2xx. Callers should surface the message to the user
 * verbatim — the server returns either a validation error
 * ("message must be non-empty") or a transient 503.
 *
 * No retry. The settings-feedback dialog holds the textarea content in
 * state; user can re-submit on failure.
 *
 * Hard-codes the LiteLLM base URL to match the one in `tos-accept.ts`.
 * If that ever moves to env-driven config, update both.
 */
const LITELLM_FEEDBACK_URL =
  "https://litellm-production-46bb.up.railway.app/gpd/feedback"

export type FeedbackCategory = "bug" | "feature" | "feedback"

export type FeedbackInput = {
  /** LiteLLM virtual key — fetched via Auth.Service / platform.readGpdKey. */
  key: string
  category: FeedbackCategory
  /** Free text. Server caps at 8000 chars; client should also cap at the
   *  textarea so users see the limit before they hit send. */
  message: string
  /** Desktop build version — strictly informational, server-side audit. */
  appVersion?: string
}

export async function postFeedback(input: FeedbackInput): Promise<{ id: string }> {
  if (!input.key) throw new Error("missing LiteLLM key")
  if (!input.message?.trim()) throw new Error("message required")

  const body: Record<string, unknown> = {
    category: input.category,
    message: input.message.trim(),
  }
  if (input.appVersion) body.app_version = input.appVersion

  const res = await fetch(LITELLM_FEEDBACK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let detail = ""
    try {
      const parsed = (await res.json()) as {
        detail?: string
        error?: { message?: string }
      }
      detail = parsed.detail ?? parsed.error?.message ?? ""
    } catch {
      // non-JSON body; fall through
    }
    throw new Error(
      `Feedback submission failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
    )
  }

  const data = (await res.json()) as { ok?: boolean; id?: string }
  return { id: data.id ?? "" }
}
