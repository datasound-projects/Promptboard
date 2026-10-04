// Leave room to preserve a full-length request and add implementation guidance.
export const COMPOSE_INPUT_CHARS = 100_000;
export const COMPOSE_PROMPT_CHARS = 200_000;
// Split coverage may inspect several task prompts with repeated shared constraints.
export const VERIFICATION_OUTPUT_CHARS = 2 * 1024 * 1024;
