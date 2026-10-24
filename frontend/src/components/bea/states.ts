import type { BeaDrawingState } from "./drawings";

/**
 * Bea's six states (docs/design/bea-character.html), each tied to a product moment:
 * - hello: the panel opens, or between answers;
 * - thinking: the model is answering (loops until text arrives);
 * - found: an answer with evidence, or a grade went up;
 * - downgrade: a grade fell, or WildWatch raised an alert;
 * - cant-answer: the Record has nothing on the question;
 * - waking: the free-tier backend is starting (about 30 s).
 */
export type BeaState =
  "hello" | "thinking" | "found" | "downgrade" | "cant-answer" | "waking";

export const BEA_DRAWING: Record<BeaState, BeaDrawingState> = {
  hello: "neutral",
  thinking: "think",
  found: "happy",
  downgrade: "alert",
  "cant-answer": "sad",
  waking: "sleep",
};

export const BEA_STATE_LABEL: Record<BeaState, string> = {
  hello: "Hello",
  thinking: "Thinking",
  found: "Found it",
  downgrade: "Downgrade",
  "cant-answer": "Can't answer",
  waking: "Waking up",
};

/** From this size up she's drawn in full; below it, as the avatar (the character sheet). */
export const BEA_CHARACTER_FROM_PX = 64;
