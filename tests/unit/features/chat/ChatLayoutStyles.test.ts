import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const containerCss = readFileSync(resolve('src/style/base/container.css'), 'utf8');
const headerCss = readFileSync(resolve('src/style/components/header.css'), 'utf8');
const historyCss = readFileSync(resolve('src/style/components/history.css'), 'utf8');
const tabsCss = readFileSync(resolve('src/style/components/tabs.css'), 'utf8');
const inputCss = readFileSync(resolve('src/style/components/input.css'), 'utf8');
const messagesCss = readFileSync(resolve('src/style/components/messages.css'), 'utf8');

describe('chat layout styles', () => {
  it('keeps header and tab badges pinned to inline start', () => {
    expect(headerCss).toMatch(/\.codian-container > \.codian-header,\s*\.codian-chat-main-pane > \.codian-header\s*\{[\s\S]*?justify-content:\s*flex-start;/);
    expect(headerCss).toMatch(/\.codian-container \.codian-title\s*\{[\s\S]*?justify-content:\s*flex-start;/);
    expect(tabsCss).toMatch(/\.codian-container \.codian-tab-badges\s*\{[\s\S]*?justify-content:\s*flex-start;/);
  });

  it('scopes user message bubble background and padding to message content rather than container', () => {
    const userMsgRule = messagesCss.match(/\.codian-message-user\s*\{([^}]*)\}/)?.[1];
    const userContentRule = messagesCss.match(/\.codian-message-user\s*>\s*\.codian-message-content\s*\{([^}]*)\}/)?.[1];
    const baseMessageRule = messagesCss.match(/\.codian-message\s*\{([^}]*)\}/)?.[1];

    expect(userMsgRule).toContain('background: transparent;');
    expect(userMsgRule).not.toContain('padding:');
    expect(baseMessageRule).not.toContain('padding:');
    expect(baseMessageRule).not.toContain('background:');

    expect(userContentRule).toContain('background: rgba(0, 0, 0, 0.3);');
    expect(userContentRule).toContain('padding: 10px 14px;');
    expect(userContentRule).toContain('border-radius: 8px;');
  });

  it('fills chat host and prevents its outer view from scrolling below composer', () => {
    expect(containerCss).toMatch(/\.codian-container\s*\{[\s\S]*?min-height:\s*100%;/);
    expect(containerCss).toMatch(/\.codian-container\s*\{[\s\S]*?box-sizing:\s*border-box;/);
    expect(inputCss).toMatch(/\.codian-input-footer\s*\{[\s\S]*?margin-top:\s*auto;/);
  });

  it('only shows conversation picker beside chat when the measured view is wide', () => {
    expect(containerCss).toMatch(/\.codian-chat-layout\.codian-wide-session-layout\s*\{[\s\S]*?grid-template-columns:\s*var\(--codian-session-sidebar-width,\s*220px\)\s+5px\s+minmax\(0,\s*1fr\);/);
    expect(containerCss).toMatch(/\.codian-chat-layout\.codian-wide-session-layout \.codian-wide-session-sidebar\s*\{[\s\S]*?display:\s*flex;/);
  });

  it('keeps unread dot visible when long conversation titles are truncated', () => {
    const unreadTitleRule = historyCss.match(/\.codian-history-item\.status-unread \.codian-history-item-title\s*\{([^}]*)\}/)?.[1];
    const unreadDotRule = historyCss.match(/\.codian-history-item-unread-dot\s*\{([^}]*)\}/)?.[1];

    expect([...historyCss.matchAll(/\.codian-history-item\.status-unread \.codian-history-item-title/g)])
      .toHaveLength(1);
    expect(unreadTitleRule).toContain('position: relative;');
    expect(unreadTitleRule).toContain('padding-inline-end: 13px;');
    expect(unreadDotRule).toContain('position: absolute;');
    expect(unreadDotRule).toContain('inset-inline-end: 2px;');
    expect(unreadDotRule).toContain('transform: translateY(-50%);');
  });
});
