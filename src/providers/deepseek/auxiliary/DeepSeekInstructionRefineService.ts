import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { DeepSeekAuxQueryRunner } from '../runtime/DeepSeekAuxQueryRunner';

export class DeepSeekInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ProviderHost) {
    super(new DeepSeekAuxQueryRunner(plugin));
  }
}
