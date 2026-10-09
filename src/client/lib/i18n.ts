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

/** Look a string up and fill its `{name}` holes. An unknown hole is left visible, never dropped. */
export function t(key: MessageKey, params?: MessageParams): string {
  const template: string = catalogues[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (hole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : hole,
  );
}
