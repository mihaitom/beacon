/** The colour arithmetic a theme is derived with - plain sRGB hex in and
 * out, so a theme built from it reads the same as one written by hand. */

type Rgb = [number, number, number]

const HEX_RE = /^#([0-9a-f]{6})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value)
}

function parse(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function format(rgb: Rgb): string {
  return (
    '#' +
    rgb
      .map((c) => Math.round(c).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

/** `amount` of `other` into `hex`, 0 to 1. */
export function mix(hex: string, other: string, amount: number): string {
  const [r1, g1, b1] = parse(hex)
  const [r2, g2, b2] = parse(other)
  return format([r1 + (r2 - r1) * amount, g1 + (g2 - g1) * amount, b1 + (b2 - b1) * amount])
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = parse(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Whether text on this background wants to be light. 0.18 is where a mid
 * grey sits on the luminance scale - halfway by eye, not by number. */
export function isDarkColor(hex: string): boolean {
  return luminance(hex) < 0.18
}

/** `hex`, moved towards white (on a dark `background`) or black (on a light
 * one) just far enough to reach `ratio` against it. An accent that already
 * reaches it comes back unchanged. */
export function towardsContrast(hex: string, background: string, ratio: number): string {
  const target = isDarkColor(background) ? '#FFFFFF' : '#000000'
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(hex, target, step / 20)
    if (contrast(candidate, background) >= ratio) return candidate
  }
  return target
}

/** "#RRGGBB" as the "r, g, b" triplet the canvas components and
 * colorExtractor.ts work in. */
export function hexToTriplet(hex: string): string {
  return parse(hex).join(', ')
}

export function tripletToHex(triplet: string): string {
  const [r = 0, g = 0, b = 0] = triplet.split(',').map((part) => Number(part.trim()))
  return format([r, g, b])
}
