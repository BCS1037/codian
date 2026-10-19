import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { DeepSeekAuxQueryRunner } from '../runtime/DeepSeekAuxQueryRunner';

export class DeepSeekInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ProviderHost) {
    super(new DeepSeekAuxQueryRunner(plugin));
  }
}
