import { en, type MessageKey } from "./en";

export type { MessageKey };
export type MessageParams = Record<string, string | number>;

const catalogues = { en } as const;
type Locale = keyof typeof catalogues;
let locale: Locale = "en";

/** English only in v1; the indirection is what a second catalogue would plug into. */
export function setLocale(next: Locale): void {
  locale = next;
}

export function getLocale(): string {
  return locale;
}

/** Fill a template's `{name}` holes. An unknown hole is left visible, never dropped. */
function fill(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (hole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : hole,
  );
}

/** Look a string up and fill its `{name}` holes. An unknown hole is left visible, never dropped. */
export function t(key: MessageKey, params?: MessageParams): string {
  return fill(catalogues[locale][key], params);
}

/**
 * A feature's own catalogue: `features/<name>/strings.ts` exports `defineMessages({ … })` and the
 * feature calls the function it returns exactly like `t`. The shell's `en.ts` holds the shell's
 * strings only. `translations` is where a second language of the same keys would plug in; a
 * locale it does not carry reads the English text.
 */
export function defineMessages<M extends Record<string, string>>(
  messages: M,
  translations: Partial<Record<Exclude<Locale, "en">, Record<keyof M, string>>> = {},
): (key: keyof M, params?: MessageParams) => string {
  const own: Partial<Record<Locale, Record<keyof M, string>>> = { ...translations, en: messages };
  return (key, params) => fill((own[locale] ?? messages)[key], params);
}
