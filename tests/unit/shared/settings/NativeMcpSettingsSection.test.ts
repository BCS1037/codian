import { renderNativeMcpSettingsSection } from '@/shared/settings/NativeMcpSettingsSection';

const createdSettings: Array<{ heading: boolean; name: string }> = [];

jest.mock('obsidian', () => ({
  Setting: class MockSetting {
    public heading = false;
    public name = '';

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    setName(name: string) {
      this.name = name;
      return this;
    }
  },
}));

function createElement(): any {
  return {
    appendText: jest.fn(),
    createEl: jest.fn(() => createElement()),
  };
}

describe('renderNativeMcpSettingsSection', () => {
  beforeEach(() => {
    createdSettings.length = 0;
  });

  it('renders heading, CLI command, and documentation link', () => {
    const notice = createElement();
    const container = {
      createDiv: jest.fn(() => notice),
    } as unknown as HTMLElement;

    const returnedNotice = renderNativeMcpSettingsSection(container, {
      descriptionAfterCommand: ' and they will be available in Codian. ',
      descriptionBeforeCommand: 'OpenCode manages MCP servers through its native CLI. Configure them with ',
      documentationLabel: 'Learn more',
      documentationUrl: 'https://opencode.ai/docs/mcp-servers/',
      heading: 'MCP Servers',
      setupCommand: 'opencode mcp add',
    });

    expect(returnedNotice).toBe(notice);
    expect(createdSettings).toEqual([{ heading: true, name: 'MCP Servers' }]);
    expect(container.createDiv).toHaveBeenCalledWith({ cls: 'claudian-mcp-settings-desc' });
    expect(notice.createEl).toHaveBeenNthCalledWith(1, 'p', {
      cls: 'setting-item-description',
    });
    const description = notice.createEl.mock.results[0].value;
    expect(description.appendText).toHaveBeenNthCalledWith(
      1,
      'OpenCode manages MCP servers through its native CLI. Configure them with ',
    );
    expect(description.createEl).toHaveBeenNthCalledWith(1, 'code');
    expect(description.createEl.mock.results[0].value.appendText)
      .toHaveBeenCalledWith('opencode mcp add');
    expect(description.appendText).toHaveBeenNthCalledWith(
      2,
      ' and they will be available in Codian. ',
    );
    expect(description.createEl).toHaveBeenNthCalledWith(2, 'a', {
      href: 'https://opencode.ai/docs/mcp-servers/',
      text: 'Learn more',
    });
  });
});
