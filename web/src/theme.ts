export const THEMES = ['dark', 'light', 'midnight'] as const;
export type ThemeId = (typeof THEMES)[number];

/** Sets data-theme on the given root. Unknown or missing themes fall back to dark. */
export function applyTheme(theme: string | undefined, root: HTMLElement): ThemeId {
  const id: ThemeId = (THEMES as readonly string[]).includes(theme ?? '') ? (theme as ThemeId) : 'dark';
  root.setAttribute('data-theme', id);
  return id;
}
