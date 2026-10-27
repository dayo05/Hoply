/** Keep SVG fragment references local when several rendered pages share a DOM. */
export function scopeSvgIds(svg: SVGSVGElement, prefix: string): void {
  const elements = [svg, ...svg.querySelectorAll('*')];
  const ids = new Map<string, string>();

  for (const element of elements) {
    if (element.id) ids.set(element.id, `${prefix}${element.id}`);
  }

  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'id') {
        attribute.value = ids.get(attribute.value) ?? attribute.value;
        continue;
      }

      // clip-path, fill, mask, filter, marker-* and inline style all use url(#id).
      attribute.value = attribute.value.replace(
        /url\(\s*(['"]?)#([^\s)'"(]+)\1\s*\)/g,
        (reference, _quote: string, id: string) =>
          ids.has(id) ? `url(#${ids.get(id)})` : reference
      );

      // Preserve the namespace of xlink:href by updating the existing Attr.
      if (attribute.localName === 'href' && attribute.value.startsWith('#')) {
        const target = ids.get(attribute.value.slice(1));
        if (target) attribute.value = `#${target}`;
      }
    }
  }
}
