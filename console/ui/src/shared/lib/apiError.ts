/** The text of an API error (the console sends {code, title, description}; some calls {message}). */
export const apiErrorText = (e: unknown, fallback = 'Request failed'): string => {
  const d = (e as { data?: { title?: string; description?: string; message?: string } } | undefined)?.data;
  if (d && typeof d === 'object') return d.title || d.description || d.message || fallback;
  if (typeof (e as { data?: unknown })?.data === 'string') return String((e as { data: string }).data) || fallback;
  return (e as { error?: string })?.error || (e instanceof Error ? e.message : fallback);
};
