import type { AskUserQuestionItem } from '../../../core/types';
import { isRecord } from './OpencodeHttpClient';

/** Convert only native form schemas the shared question UI can represent safely. */
export function projectOpencodeFormQuestions(
  form: Record<string, unknown>,
): AskUserQuestionItem[] {
  const fields = Array.isArray(form.fields) ? form.fields.filter(isRecord) : [];
  const metadata = isRecord(form.metadata) ? form.metadata : {};
  const questionTool = metadata.kind === 'question';
  const mcpForm = metadata.kind === 'mcp-elicitation';
  const unsupported = fields.some((field) => {
    if (!['string', 'multiselect', 'number', 'integer', 'boolean'].includes(String(field.type))
      || field.hidden === true || (Array.isArray(field.when) && field.when.length > 0)) {
      return true;
    }
    if (!mcpForm) return false;
    return field.required !== true || field.default !== undefined
      || ['number', 'integer'].includes(String(field.type))
      || ['format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'maxItems']
        .some((key) => field[key] !== undefined)
      || (field.type === 'multiselect' && field.minItems !== 1);
  });
  if (fields.length === 0 || unsupported) {
    throw new Error('Unsupported OpenCode form: this form requires field semantics unavailable in Codian.');
  }

  return fields.map((field) => {
    const key = stringValue(field.key) ?? '';
    if (!key) throw new Error('Unsupported OpenCode form: field key is missing.');
    const options = Array.isArray(field.options)
      ? field.options.filter(isRecord).map((option) => ({
        label: String(option.label),
        value: typeof option.value === 'string' ? option.value : String(option.label),
        description: typeof option.description === 'string' ? option.description : '',
      }))
      : [];
    return {
      id: key,
      header: questionTool ? stringValue(field.title) ?? 'Question' : stringValue(form.title) ?? 'Question',
      question: questionTool
        ? stringValue(field.description) ?? stringValue(field.title) ?? key
        : [metadata.message, field.title, field.description]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .filter((value, index, values) => values.indexOf(value) === index)
          .join('\n\n') || key,
      multiSelect: field.type === 'multiselect',
      isOther: field.custom === true
        || ['number', 'integer'].includes(String(field.type))
        || (field.type === 'string' && !Array.isArray(field.options)),
      options: field.type === 'boolean'
        ? [
          { label: 'True', value: 'true', description: '' },
          { label: 'False', value: 'false', description: '' },
        ]
        : options,
    };
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
