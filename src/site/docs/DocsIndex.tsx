import { SiteFooter } from '../shell/SiteFooter'
import { SiteHeader } from '../shell/SiteHeader'
import { docsPath } from '../shell/links'
import { docsLead, docsSections } from './pages'
import '../styles/tokens.css'
import '../styles/site.css'
import '../styles/docs.css'

/** The docs home: every section as a list of outlined rows, each page's title over its one-line summary. */
export function DocsIndex() {
  return <>
    <SiteHeader current="docs" />
    <main id="main" className="docs-home">
      <header className="docs-home-head"><p className="kicker">Handset</p><h1 className="outline">Docs</h1><p className="docs-lead">{docsLead}</p></header>
      {docsSections.map((section, index) => <section key={section.title} aria-labelledby={`docs-section-${index}`} className="docs-home-section">
        <h2 id={`docs-section-${index}`} className="kicker">{section.title}</h2>
        <ul className="docs-rows">{section.pages.map(page => <li key={page.slug}><a className="docs-row" href={docsPath(page.slug)}><span className="docs-row-title">{page.title}</span><span className="docs-row-summary">{page.summary}</span><span className="arrow" aria-hidden="true">→</span></a></li>)}</ul>
      </section>)}
    </main>
    <SiteFooter />
  </>
}
