import {
  createCliPathFingerprintInputs,
  hasCliPathFingerprintInputs,
} from '@/core/providers/cli/CliPathFingerprintInputs';

describe('CLI path fingerprint inputs', () => {
  it('normalizes configured hostname and legacy candidates independently', () => {
    expect(createCliPathFingerprintInputs(
      ' /configured/hostname-cli ',
      ' /configured/legacy-cli ',
    )).toEqual({
      hostnameCliPath: '/configured/hostname-cli',
      legacyCliPath: '/configured/legacy-cli',
    });
    expect(hasCliPathFingerprintInputs({
      hostnameCliPath: '/configured/hostname-cli',
      legacyCliPath: '/configured/legacy-cli',
    })).toBe(true);
  });

  it('represents missing candidates explicitly', () => {
    const inputs = createCliPathFingerprintInputs(undefined, '  ');

    expect(inputs).toEqual({ hostnameCliPath: '', legacyCliPath: '' });
    expect(hasCliPathFingerprintInputs(inputs)).toBe(false);
  });
});
