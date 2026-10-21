import { links } from './links'

/** The page's one action, the mint Run Handset, then the text links. The hero carries the demo; the closing does not. */
export function Actions({ demo = true, className = '' }: { demo?: boolean; className?: string }) {
  return <div className={`cta-row ${className}`.trim()}>
    <a className="run-button" href={links.run}>Run Handset<span className="arrow" aria-hidden="true">→</span></a>
    {demo && <a className="text-link" href={links.demo}>Try the demo</a>}
    <a className="text-link" href={links.docs}>Read the docs</a>
  </div>
}
