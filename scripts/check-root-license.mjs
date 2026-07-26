import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_AGPL_3_0_SHA256 = '8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef';
const licensePath = path.resolve('LICENSE');
const actual = crypto.createHash('sha256').update(fs.readFileSync(licensePath)).digest('hex');

if (actual !== EXPECTED_AGPL_3_0_SHA256) {
  throw new Error('LICENSE must match the canonical GNU AGPL-3.0 text for repository recognition.');
}

process.stdout.write('Canonical AGPL-3.0 license verified.\n');
