// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-ask-user.mjs — dsh's questions to the user, asked through codex's
 * question UI.
 *
 * dsh's `ask_user_question` (and `exit_plan_mode`, which asks for a plan's
 * approval) wait on an answerer; unieai-control forwards the questions here.
 * The client has codex's request_user_input screen, driven by the
 * `item/tool/requestUserInput` server request: options to pick from, an
 * "Other" line, and notes, answered as `[label, "user_note: …"]`. This maps
 * one onto the other.
 */

const NOTE_PREFIX = "user_note: ";
/** The protocol asks for a short header (the TUI draws it as a tab). */
const HEADER_LIMIT = 12;

/** dsh questions -> the protocol's ToolRequestUserInputQuestion list. */
export function protocolQuestions(questions) {
  return questions.map((question, index) => ({
    id: String(question.id ?? `q${index + 1}`),
    header: String(question.header || `Question ${index + 1}`).slice(0, HEADER_LIMIT),
    question: String(question.question ?? ""),
    // The client always offers a free-form answer, as codex's tool does.
    isOther: true,
    isSecret: false,
    options: question.options?.length
      ? question.options.map((option) => ({ label: String(option.label), description: String(option.description ?? "") }))
      : null,
  }));
}

/**
 * The client's answers -> dsh's `{ id, selected, custom? }` per question: the
 * labels of the options picked, and what the user typed as `custom`.
 */
export function dshAnswers(questions, response) {
  return questions.map((question, index) => {
    const id = String(question.id ?? `q${index + 1}`);
    const given = response?.answers?.[id]?.answers ?? [];
    const labels = new Set((question.options ?? []).map((option) => String(option.label)));
    const selected = given.filter((answer) => labels.has(answer));
    const notes = given
      .filter((answer) => answer.startsWith(NOTE_PREFIX))
      .map((answer) => answer.slice(NOTE_PREFIX.length).trim())
      .filter(Boolean);
    return { id, selected, ...(notes.length ? { custom: notes.join("\n") } : {}) };
  });
}

/**
 * The text a question reviews (exit_plan_mode's plan), shown before the
 * question: the question screen has room for a sentence, not a plan.
 */
export function questionDetails(questions) {
  return questions.map((question) => question.detail).filter((detail) => typeof detail === "string" && detail.trim());
}
