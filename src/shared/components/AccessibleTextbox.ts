export type PopupTextboxAttribute =
  | 'aria-activedescendant'
  | 'aria-autocomplete'
  | 'aria-controls'
  | 'aria-haspopup';

export type PopupTextboxAttributes = Partial<Record<PopupTextboxAttribute, string>>;

interface TextboxResolverEntry {
  readonly resolve: () => HTMLElement;
}

interface OwnedAttribute {
  readonly owner: object;
  readonly value: string;
}

const textboxResolvers = new WeakMap<HTMLElement, TextboxResolverEntry[]>();
const ownedAttributes = new WeakMap<HTMLElement, Map<PopupTextboxAttribute, OwnedAttribute>>();

export function registerAccessibleTextbox(
  inputEl: HTMLElement,
  resolve: () => HTMLElement,
): () => void {
  const entry = { resolve };
  const entries = textboxResolvers.get(inputEl) ?? [];
  entries.push(entry);
  textboxResolvers.set(inputEl, entries);

  return () => {
    const registeredEntries = textboxResolvers.get(inputEl);
    if (!registeredEntries) return;
    const index = registeredEntries.indexOf(entry);
    if (index < 0) return;
    registeredEntries.splice(index, 1);
    if (registeredEntries.length === 0) textboxResolvers.delete(inputEl);
  };
}

export function getAccessibleTextbox(inputEl: HTMLElement): HTMLElement {
  const entries = textboxResolvers.get(inputEl);
  return entries?.[entries.length - 1]?.resolve() ?? inputEl;
}

/** Owns popup relationships without restoring stale values from another menu. */
export class InputPopupRelationships {
  private readonly owner = {};
  private targetEl: HTMLElement | null = null;
  private values = new Map<PopupTextboxAttribute, string>();

  constructor(private readonly inputEl: HTMLElement) {}

  set(attributes: PopupTextboxAttributes): void {
    const targetEl = getAccessibleTextbox(this.inputEl);
    if (targetEl !== this.targetEl) {
      this.releaseCurrentTarget();
      this.targetEl = targetEl;
    }

    const nextValues = new Map(
      Object.entries(attributes).filter((entry): entry is [PopupTextboxAttribute, string] => (
        typeof entry[1] === 'string'
      )),
    );
    const registry = getOwnedAttributeRegistry(targetEl);

    for (const [attribute] of this.values) {
      if (!nextValues.has(attribute)) this.releaseAttribute(registry, attribute, targetEl);
    }

    for (const [attribute, value] of nextValues) {
      registry.set(attribute, { owner: this.owner, value });
      targetEl.setAttribute(attribute, value);
    }

    this.values = nextValues;
  }

  release(): void {
    this.releaseCurrentTarget();
    this.targetEl = null;
    this.values.clear();
  }

  private releaseCurrentTarget(): void {
    if (!this.targetEl) return;
    const registry = getOwnedAttributeRegistry(this.targetEl);
    for (const attribute of this.values.keys()) {
      this.releaseAttribute(registry, attribute, this.targetEl);
    }
    this.values.clear();
  }

  private releaseAttribute(
    registry: Map<PopupTextboxAttribute, OwnedAttribute>,
    attribute: PopupTextboxAttribute,
    targetEl: HTMLElement,
  ): void {
    const owned = registry.get(attribute);
    if (owned?.owner !== this.owner) return;
    if (targetEl.getAttribute(attribute) === owned.value) targetEl.removeAttribute(attribute);
    registry.delete(attribute);
  }
}

function getOwnedAttributeRegistry(targetEl: HTMLElement): Map<PopupTextboxAttribute, OwnedAttribute> {
  let registry = ownedAttributes.get(targetEl);
  if (!registry) {
    registry = new Map();
    ownedAttributes.set(targetEl, registry);
  }
  return registry;
}
