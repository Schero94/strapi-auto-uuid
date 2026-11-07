/**
 * Parses pasted or uploaded export JSON.
 *
 * @param {string} text Raw text.
 * @returns {{ value: Object|null, error: 'empty'|'json'|'shape'|null }} Parse result.
 */
export const parseMappings = (text) => {
  if (!text.trim()) return { value: null, error: 'empty' };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || typeof value.mappings !== 'object') {
      return { value: null, error: 'shape' };
    }
    return { value, error: null };
  } catch {
    return { value: null, error: 'json' };
  }
};
