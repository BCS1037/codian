import { TFile } from 'obsidian';

import { addFileToCodian } from '@/features/chat/fileMenu';

describe('addFileToCodian', () => {
  it('reveals Codian and appends a vault mention without sending', async () => {
    const appendToActiveInput = jest.fn().mockReturnValue(true);
    const host = {
      activateView: jest.fn().mockResolvedValue(undefined),
      getView: jest.fn().mockReturnValue({ appendToActiveInput }),
    } as any;

    const file = Object.assign(Object.create(TFile.prototype), { path: 'notes/plan.md' }) as TFile;
    await expect(addFileToCodian(host, file)).resolves.toBe(true);

    expect(host.activateView).toHaveBeenCalledTimes(1);
    expect(appendToActiveInput).toHaveBeenCalledWith('@notes/plan.md');
  });
});
