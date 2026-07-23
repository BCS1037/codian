import {
  encodeProviderModelSelectionId,
  isProviderModelSelectionId,
  toProviderRuntimeModelId,
} from '../../core/providers/modelSelection';
import { decodeClaudeServiceModelSelection } from './services/ClaudeThirdPartyServices';

export function encodeClaudeModelSelectionId(modelId: string): string {
  return encodeProviderModelSelectionId('claude', modelId);
}

export function isClaudeModelSelectionId(modelId: string): boolean {
  return isProviderModelSelectionId('claude', modelId);
}

export function toClaudeRuntimeModelId(modelId: string): string {
  const serviceSelection = decodeClaudeServiceModelSelection(modelId);
  if (serviceSelection) {
    return serviceSelection.modelId;
  }
  return toProviderRuntimeModelId('claude', modelId);
}
