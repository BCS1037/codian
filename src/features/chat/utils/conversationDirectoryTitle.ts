const CONVERSATION_DIRECTORY_TITLE_MAX_LENGTH = 80;

export function formatConversationDirectoryTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) return '';
  if (firstLine.length <= CONVERSATION_DIRECTORY_TITLE_MAX_LENGTH) return firstLine;
  const limit = CONVERSATION_DIRECTORY_TITLE_MAX_LENGTH - 3;
  // Back off one unit when the cut would split a surrogate pair.
  const splitsPair = firstLine.charCodeAt(limit - 1) >= 0xd800 && firstLine.charCodeAt(limit - 1) <= 0xdbff
    && firstLine.charCodeAt(limit) >= 0xdc00 && firstLine.charCodeAt(limit) <= 0xdfff;
  return `${firstLine.slice(0, splitsPair ? limit - 1 : limit)}...`;
}
