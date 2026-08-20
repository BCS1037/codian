const MEMORY_CITATION_OPEN = '<oai-mem-citation>';
const MEMORY_CITATION_CLOSE = '</oai-mem-citation>';

export function stripCodexMemoryCitationMarkup(text: string): string {
  let cursor = 0;
  let visibleText = '';

  while (cursor < text.length) {
    const openIndex = text.indexOf(MEMORY_CITATION_OPEN, cursor);
    if (openIndex < 0) {
      visibleText += text.slice(cursor);
      break;
    }

    visibleText += text.slice(cursor, openIndex);
    const bodyStart = openIndex + MEMORY_CITATION_OPEN.length;
    const closeIndex = text.indexOf(MEMORY_CITATION_CLOSE, bodyStart);
    if (closeIndex < 0) {
      break;
    }
    cursor = closeIndex + MEMORY_CITATION_CLOSE.length;
  }

  return visibleText;
}
