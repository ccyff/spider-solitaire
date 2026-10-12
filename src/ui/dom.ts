type Props = {
  class?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
};

/** 极简 DOM 构造助手，避免到处都是 createElement 噪音 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) node.setAttribute(key, value);
  }
  if (props.style) Object.assign(node.style, props.style);
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) {
      if (handler) node.addEventListener(event, handler as EventListener);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  return el('button', {
    class: className,
    text: label,
    attrs: { type: 'button' },
    on: { click: onClick },
  });
}
