type TestWindow = typeof globalThis & {
  cancelAnimationFrame?: (handle: number) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
};

const testWindow = globalThis as TestWindow;

if (!testWindow.requestAnimationFrame) {
  testWindow.requestAnimationFrame = (callback: FrameRequestCallback): number => (
    Number(setTimeout(() => callback(Date.now()), 0))
  );
}

if (!testWindow.cancelAnimationFrame) {
  testWindow.cancelAnimationFrame = (handle: number): void => {
    clearTimeout(handle);
  };
}

const testHTMLElement = (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
if (testHTMLElement && typeof testHTMLElement.prototype.createEl !== 'function') {
  const createChild = function(this: HTMLElement, tagName: string, options?: any): HTMLElement {
    const child = this.ownerDocument.createElement(tagName);
    if (options?.cls) child.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
    if (options?.text !== undefined) child.textContent = options.text;
    if (options?.attr) {
      for (const [name, value] of Object.entries(options.attr)) {
        child.setAttribute(name, String(value));
      }
    }
    this.appendChild(child);
    return child;
  };

  testHTMLElement.prototype.createEl = createChild as typeof testHTMLElement.prototype.createEl;
  testHTMLElement.prototype.createDiv = function(options?: any): HTMLDivElement {
    return createChild.call(this, 'div', options) as HTMLDivElement;
  };
  testHTMLElement.prototype.createSpan = function(options?: any): HTMLSpanElement {
    return createChild.call(this, 'span', options) as HTMLSpanElement;
  };
}

const testGlobal = globalThis as Record<string, any>;
const createSvgElement = function(this: any, tagName: string, options?: any): SVGElement {
  const ownerDocument = this.nodeType === 9 ? this : this.ownerDocument;
  const element = ownerDocument.createElementNS('http://www.w3.org/2000/svg', tagName);
  if (options?.cls) element.setAttribute('class', Array.isArray(options.cls) ? options.cls.join(' ') : options.cls);
  if (options?.text !== undefined) element.textContent = options.text;
  if (options?.attr) {
    for (const [name, value] of Object.entries(options.attr)) {
      element.setAttribute(name, String(value));
    }
  }
  if (this.nodeType !== 9) this.appendChild(element);
  return element;
};

const testElement = (globalThis as { Element?: typeof Element }).Element;
if (testElement && typeof (testElement.prototype as any).createSvg !== 'function') {
  (testElement.prototype as any).createSvg = createSvgElement;
}
const testDocument = (globalThis as { Document?: typeof Document }).Document;
if (testDocument && typeof (testDocument.prototype as any).createSvg !== 'function') {
  (testDocument.prototype as any).createSvg = createSvgElement;
}
const testDocumentFragment = (globalThis as { DocumentFragment?: typeof DocumentFragment }).DocumentFragment;
if (testDocumentFragment && typeof (testDocumentFragment.prototype as any).createSvg !== 'function') {
  (testDocumentFragment.prototype as any).createSvg = createSvgElement;
}

const createDomElement = (tagName: string, options?: any): HTMLElement => {
  const element = testGlobal.document?.createElement?.(tagName);
  if (!element) throw new Error(`Test document cannot create ${tagName}`);
  if (options?.cls) element.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
  if (options?.text !== undefined) element.textContent = options.text;
  if (options?.attr) {
    for (const [name, value] of Object.entries(options.attr)) {
      element.setAttribute(name, String(value));
    }
  }
  return element;
};

testGlobal.createEl ??= createDomElement;
testGlobal.createDiv ??= (options?: any) => createDomElement('div', options);
testGlobal.createSpan ??= (options?: any) => createDomElement('span', options);
testGlobal.createSvg ??= (tagName: string, options?: any) => {
  const ownerDocument = testGlobal.document;
  return createSvgElement.call(ownerDocument, tagName, options);
};
testGlobal.createFragment ??= () => testGlobal.document?.createDocumentFragment?.();

if (!('window' in globalThis)) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: testWindow,
    writable: true,
  });
}
