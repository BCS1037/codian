import { Notice } from 'obsidian';

import { t } from '../../../i18n/i18n';
import { LivePreviewInputBridge } from './LivePreviewInputBridge';
import type {
  ComposerEnhancement,
  ComposerEnhancementContext,
  ComposerSession,
} from './types';
import { VaultContextDropController } from './VaultContextDropController';

export class LivePreviewComposerEnhancement implements ComposerEnhancement {
  mount(context: ComposerEnhancementContext): ComposerSession {
    const hostEl = context.inputWrapperEl.createDiv({ cls: 'claudian-live-preview-host' });
    const bridge = new LivePreviewInputBridge(context.sourceEl, hostEl, {
      references: context.initialReferences,
      onOpenReference: context.onOpenReference,
    });
    const dropController = new VaultContextDropController(
      context.app,
      context.dropZoneEl,
      context.sourceEl,
      {
        onReferencesDropped: context.onReferencesDropped,
        onInvalidDrop: () => new Notice(t('chat.drop.invalid')),
      },
    );
    context.setReferenceSink(references => bridge.setReferences(references));

    return {
      focusTargetEl: hostEl,
      onDraftConsumed: () => bridge.syncFromSource(),
      onConversationReset: () => bridge.syncFromSource(),
      destroy: () => {
        context.setReferenceSink(null);
        dropController.destroy();
        bridge.destroy();
        hostEl.remove();
      },
    };
  }
}
