import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import { resolveTitleGenerationLocale } from '../../../core/prompt/titleGeneration';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { DeepSeekAuxQueryRunner } from '../runtime/DeepSeekAuxQueryRunner';
import { deepseekChatUIConfig } from '../ui/DeepSeekChatUIConfig';

export class DeepSeekTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ProviderHost) {
    super({
      createRunner: () => new DeepSeekAuxQueryRunner(plugin),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        return deepseekChatUIConfig.ownsModel(titleModel, settings) ? titleModel : undefined;
      },
      resolveLocale: () => resolveTitleGenerationLocale(plugin.settings),
    });
  }
}
