import { Lockup } from './Lockup'
import { links } from './links'

/** The header on every run-site page: the lockup, then Docs, Contract and Source, one row on phones too.
 * `overArt` lays it over the homepage's photogram. */
export function SiteHeader({ current, overArt = false }: { current?: 'docs' | 'contract'; overArt?: boolean }) {
  return <header className={`site-header${overArt ? ' over-art' : ''}`}>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="site-header-row">
      <Lockup size={36} />
      <nav aria-label="Main">
        <a href={links.docs} aria-current={current === 'docs' ? 'page' : undefined}>Docs</a>
        <a href={links.contract} aria-current={current === 'contract' ? 'page' : undefined}>Contract</a>
        <a href={links.source}>Source</a>
      </nav>
    </div>
  </header>
}
