import type { MemoryEntry, MemoryExtractionResult } from './types';

const MIN_CONTAINMENT_LENGTH = 10;

const EXPLICIT_PATTERNS: RegExp[] = [
  /(?:请|帮我)?(?:记住|记得|记录下|记下)[：:\s]*(.+)/,
  /别忘了[：:\s]*(.+)/,
  /(?:please\s+)?remember(?:\s+that)?[,:\s]+(.+)/i,
  /keep\s+in\s+mind[,:\s]+(.+)/i,
  /note\s+that[,:\s]+(.+)/i,
  /save\s+(?:this\s+)?(?:to\s+)?memory[,:\s]+(.+)/i,
];

const FORGET_PATTERNS: RegExp[] = [
  /(?:请|帮我)?(?:忘记|忘掉|删除记忆|移除记忆)[：:\s]*(.+)/,
  /forget(?:\s+that)?[,:\s]+(.+)/i,
  /remove\s+(?:the\s+)?memory[,:\s]+(.+)/i,
  /delete\s+(?:the\s+)?memory[,:\s]+(.+)/i,
];

const LIST_PATTERNS: RegExp[] = [
  /(?:列出|显示|查看|展示)(?:所有)?记忆/,
  /我(?:有哪些|有什么)记忆/,
  /list\s+(?:all\s+)?(?:my\s+)?memories/i,
  /show\s+(?:all\s+)?(?:my\s+)?memories/i,
  /what\s+(?:do\s+you\s+)?(?:know|remember)\s+about\s+me/i,
];

const IMPLICIT_PATTERNS: Array<{
  pattern: RegExp;
  category: string;
  extract: (match: RegExpMatchArray) => string;
}> = [
  { pattern: /我(?:比较|很|非常|特别)?喜欢(.{3,80})/, category: 'User Preferences', extract: match => `Likes ${match[1]}` },
  { pattern: /我(?:比较|很|非常|特别)?偏好(.{3,80})/, category: 'User Preferences', extract: match => `Prefers ${match[1]}` },
  { pattern: /我(?:通常|一般|平时|习惯)(.{3,80})/, category: 'Work Habits', extract: match => `Usually ${match[1]}` },
  { pattern: /我不(?:喜欢|想要|希望)(.{3,80})/, category: 'User Preferences', extract: match => `Dislikes ${match[1]}` },
  { pattern: /(?:我的|我们)?项目(?:使用|采用)(.{3,80})/, category: 'Project Context', extract: match => `Project uses ${match[1]}` },
  { pattern: /不对[，, ]*应该(?:是|用)(.{3,80})/, category: 'Rules', extract: match => `Correction: use ${match[1]}` },
  { pattern: /I\s+(?:really\s+|very\s+)?(?:like|love|prefer|enjoy)\s+(.{3,80})/i, category: 'User Preferences', extract: match => `Prefers ${match[1]}` },
  { pattern: /I\s+(?:usually|normally|typically|always)\s+(.{3,80})/i, category: 'Work Habits', extract: match => `Usually ${match[1]}` },
  { pattern: /I\s+don't\s+(?:like|want|prefer)\s+(.{3,80})/i, category: 'User Preferences', extract: match => `Dislikes ${match[1]}` },
  { pattern: /(?:our|my|the)\s+project\s+(?:uses?|is\s+using)\s+(.{3,80})/i, category: 'Project Context', extract: match => `Project uses ${match[1]}` },
  { pattern: /(?:no|actually)[,:\s]+(?:it\s+)?should\s+(?:be|use)\s+(.{3,80})/i, category: 'Rules', extract: match => `Correction: should use ${match[1]}` },
];

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /(?:偏好|preference|喜欢|prefer|favorite)/i, category: 'User Preferences' },
  { pattern: /(?:项目|project|技术栈|tech|framework)/i, category: 'Project Context' },
  { pattern: /(?:习惯|habit|workflow|流程|工作方式)/i, category: 'Work Habits' },
  { pattern: /(?:规则|rule|always|never|总是|从不|必须|禁止)/i, category: 'Rules' },
  { pattern: /(?:语言|language|中文|英文|Chinese|English|日语|Japanese)/i, category: 'Language' },
  { pattern: /(?:工具|tool|编辑器|editor|IDE|插件|plugin)/i, category: 'Tools' },
];

/** Extracts only durable user-facing facts; it never inspects assistant output. */
export class MemoryExtractor {
  extract(message: string, existingEntries: MemoryEntry[]): MemoryExtractionResult {
    return { entries: this.filterDuplicates(this.extractExplicit(message), existingEntries) };
  }

  extractImplicit(message: string, existingEntries: MemoryEntry[]): MemoryExtractionResult {
    const now = Date.now();
    const entries = IMPLICIT_PATTERNS.flatMap(({ pattern, category, extract }) => {
      const match = message.match(pattern);
      const content = match ? extract(match).trim() : '';
      return content.length >= 3 ? [{
        id: `mem_implicit_${now}_${category}`,
        category,
        content,
        source: 'user-implicit' as const,
        createdAt: now,
        updatedAt: now,
      }] : [];
    });
    return { entries: this.filterDuplicates(entries, existingEntries) };
  }

  extractForgetRequest(message: string): string | null {
    for (const pattern of FORGET_PATTERNS) {
      const term = message.match(pattern)?.[1]?.trim();
      if (term && term.length >= 3) return term;
    }
    return null;
  }

  isListRequest(message: string): boolean {
    return LIST_PATTERNS.some(pattern => pattern.test(message));
  }

  private extractExplicit(message: string): MemoryEntry[] {
    for (const pattern of EXPLICIT_PATTERNS) {
      const content = message.match(pattern)?.[1]?.trim();
      if (!content || content.length < 3) continue;
      const now = Date.now();
      return [{
        id: `mem_explicit_${now}`,
        category: this.inferCategory(content),
        content,
        source: 'user-explicit',
        createdAt: now,
        updatedAt: now,
      }];
    }
    return [];
  }

  private inferCategory(content: string): string {
    return CATEGORY_PATTERNS.find(({ pattern }) => pattern.test(content))?.category ?? 'User Preferences';
  }

  private filterDuplicates(entries: MemoryEntry[], existing: MemoryEntry[]): MemoryEntry[] {
    return entries.filter(entry => !existing.some(candidate => this.isDuplicate(entry.content, candidate.content)));
  }

  private isDuplicate(left: string, right: string): boolean {
    const normalizedLeft = left.trim().toLocaleLowerCase();
    const normalizedRight = right.trim().toLocaleLowerCase();
    if (normalizedLeft === normalizedRight) return true;
    return (normalizedLeft.length >= MIN_CONTAINMENT_LENGTH && normalizedRight.includes(normalizedLeft))
      || (normalizedRight.length >= MIN_CONTAINMENT_LENGTH && normalizedLeft.includes(normalizedRight));
  }
}
