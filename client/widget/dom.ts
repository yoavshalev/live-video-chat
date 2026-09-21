/**
 * A ~30-line DOM builder, used instead of `innerHTML` throughout the widget.
 *
 * Two reasons, both about running inside other people's pages. Visitor-supplied
 * text (a name, a question echoed back) never becomes markup, because `text` is
 * assigned to `textContent` and there is no code path that parses a string as
 * HTML. And sites that enforce Trusted Types reject `innerHTML` outright — a
 * widget built on it simply does not run there.
 */

type Attrs = Record<string, string | number | boolean | null | undefined>

export interface ElOptions {
  class?: string
  text?: string
  attrs?: Attrs
  html?: never
  on?: Record<string, (event: Event) => void>
  children?: Array<Node | string | null | undefined>
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.class) node.className = options.class
  if (options.text !== undefined) node.textContent = options.text

  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === null || value === undefined || value === false) continue
      node.setAttribute(key, value === true ? '' : String(value))
    }
  }
  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      node.addEventListener(event, handler)
    }
  }
  if (options.children) {
    for (const child of options.children) {
      if (child === null || child === undefined) continue
      node.append(typeof child === 'string' ? document.createTextNode(child) : child)
    }
  }
  return node
}

/** Replaces a container's children in one operation. */
export function replace(container: Element, ...children: Array<Node | null | undefined>): void {
  container.replaceChildren(...children.filter((child): child is Node => Boolean(child)))
}

/** Inline SVG icon. Built node-by-node so it needs no HTML parsing. */
export function icon(path: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  node.setAttribute('d', path)
  svg.append(node)
  return svg
}

export const ICONS = {
  close: 'M18 6 6 18M6 6l12 12',
  chevronDown: 'm6 9 6 6 6-6',
  soundOn: 'M11 5 6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07',
  soundOff: 'M11 5 6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6'
} as const
