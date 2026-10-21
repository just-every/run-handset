import { Lockup } from './Lockup'
import { links } from './links'

/** The footer on every run-site page, set as type under a hairline: the lockup, the category line, then Docs, Contract and Source. */
export function SiteFooter() {
  return <footer className="site-footer">
    <div className="site-footer-row">
      <div className="site-footer-brand"><Lockup size={34} /><p>Free, open source business phone system</p></div>
      <nav aria-label="Footer">
        <a href={links.docs}>Docs</a>
        <a href={links.contract}>Contract</a>
        <a href={links.source}>Source</a>
      </nav>
    </div>
  </footer>
}
