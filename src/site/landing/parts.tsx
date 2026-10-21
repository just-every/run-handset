// The pieces every screen is made of. Every string is real text over a plate with nothing painted on it.
import { Fragment, type ReactNode } from 'react'

/** An x-ray photogram cut from the desk's plates: AVIF, then WebP, at the widths public/site holds. */
export function Plate({ name, widths, sizes, width, height, className, phone, eager = false }: {
  name: string; widths: number[]; sizes: string; width: number; height: number; className?: string
  phone?: { name: string; widths: number[]; media: string; sizes: string }; eager?: boolean
}) {
  const set = (n: string, ws: number[], ext: string) => ws.map(w => `/site/${n}-${w}.${ext} ${w}w`).join(', ')
  return <picture className={className}>
    {phone && <source media={phone.media} type="image/avif" srcSet={set(phone.name, phone.widths, 'avif')} sizes={phone.sizes} />}
    {phone && <source media={phone.media} type="image/webp" srcSet={set(phone.name, phone.widths, 'webp')} sizes={phone.sizes} />}
    <source type="image/avif" srcSet={set(name, widths, 'avif')} sizes={sizes} />
    <img src={`/site/${name}-${Math.max(...widths)}.webp`} srcSet={set(name, widths, 'webp')} sizes={sizes} width={width} height={height} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" fetchPriority={eager ? 'high' : undefined} />
  </picture>
}

/** A record line: each part stays whole, and its " ·" stays with the part before it, so a wrapped line never starts with a separator. */
export const Rec = ({ parts, className }: { parts: ReactNode[]; className?: string }) =>
  <span className={className}>{parts.map((part, index) => <Fragment key={index}>{index ? ' ' : ''}<span className="nw">{part}{index < parts.length - 1 ? '\u00a0·' : ''}</span></Fragment>)}</span>

/** A screen of the page: one outline heading (its id is `${id}-title`), at most one sentence and one proof. A screen
 * without a heading names itself with `label`. */
export function Screen({ id, className, label, children }: { id: string; className: string; label?: string; children: ReactNode }) {
  return <section id={id} className={`screen ${className}`} aria-labelledby={label ? undefined : `${id}-title`} aria-label={label}>
    <div className="stage">{children}</div>
  </section>
}

/** The outline heading every screen opens with: lines as the desk set them, words never run together. */
export const Heading = ({ id, lines }: { id: string; lines: string[] }) =>
  <h2 id={id} className="outline heading">{lines.map((line, index) => <span className="line" key={index}>{line} </span>)}</h2>

/** The screen's one sentence, broken where the desk's plate breaks it on wide screens and wrapping freely on phones. */
export const Sentence = ({ lines }: { lines: string[] }) =>
  <p className="sentence">{lines.map((line, index) => <span className="line" key={index}>{line} </span>)}</p>
