/** Conservative, zero-I/O rejection of clearly non-actionable input. Ambiguity goes to the planner. */
export const NO_TASK = {
  en: 'No actionable task was detected. Provide a goal or instruction such as “build…”, “analyze…”, “implement…”, “design…”, or “explain…”.',
  de: 'Keine ausführbare Aufgabe erkannt. Beschreibe ein Ziel, zum Beispiel „erstelle…“, „analysiere…“, „implementiere…“ oder „erkläre…“.',
  pl: 'Nie wykryto konkretnego zadania. Podaj cel lub polecenie, na przykład „zbuduj…”, „przeanalizuj…”, „zaimplementuj…” lub „wyjaśnij…”.',
};
export function obviouslyNonActionable(input) {
  const text = input.trim();
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length || /^([\p{L}\p{N}])\1{4,}$/u.test(text)) return true;
  if (/^(hi|hello|hey|lol|haha|test|testing|asdf|qwerty|cześć|witaj|hallo|servus)[!.\s]*$/i.test(text)) return true;
  // Single words contain no objective/object relationship. Do not choose one for the user.
  return words.length === 1 && !(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(text) && text.length > 4);
}
export function assertActionable(input, language = 'en') {
  if (obviouslyNonActionable(input)) throw Object.assign(new TypeError(NO_TASK[language] || NO_TASK.en), { status: 422, code: 'NON_ACTIONABLE_INPUT' });
}
