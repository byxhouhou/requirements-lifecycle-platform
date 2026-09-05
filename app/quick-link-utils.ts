export const normalizeQuickLink = (value: string): string => {
  const text = value.trim().replace(/^"(.*)"$/, "$1");
  if (!text || /[\u0000-\u001f]/.test(text)) return "";
  if (/^\\\\[^\\]+\\[^\\]+/.test(text)) return text;
  if (/^[a-z]:[\\/]/i.test(text)) return text.replaceAll("/", "\\");
  if (/^file:/i.test(text)) {
    try {
      const url = new URL(text);
      const path = decodeURIComponent(url.pathname).replaceAll("/", "\\");
      if (url.hostname && url.hostname !== "localhost") return `\\\\${url.hostname}${path}`;
      return /^\\[a-z]:\\/i.test(path) ? path.slice(1) : "";
    } catch { return ""; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^(https?:|localhost:\d|127\.0\.0\.1:\d)/i.test(text)) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : text.startsWith("//") ? `https:${text}` : /^(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(text) ? `http://${text}` : `https://${text}`);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
};

export const isFileQuickLink = (value: string) => /^(\\\\|[a-z]:\\)/i.test(value);
