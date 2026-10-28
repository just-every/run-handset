// The run site (run-handset.com) `rer build --site` writes: the homepage with its Run action, /run, the docs from
// docs/*.md, /contract from CONTRACT.md, and the not-found page. Every Run page string and command is in run.json;
// nothing here reads installation data.
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { contractPageHtml } from '../base/contract-page'
import { runPricing } from '../base/run-pricing'
import { runPageHtml, siteNotFoundHtml, type RunData, type SiteBuild, type SiteContext } from '../base/run-site'
import { identity } from '../identity'
import { wearSite } from './base-pages'
import { DocsArticle } from './docs/DocsArticle'
import { DocsIndex } from './docs/DocsIndex'
import { docsHead, docsPages } from './docs/pages'
import { Landing } from './landing/Landing'
import run from './run.json'
import { usContract } from './us-spelling'

// Code cards get their Copy button only when script runs; without it the command is still there to select.
const COPY = "document.querySelectorAll('.docs-copy').forEach(b=>{b.hidden=false;b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(b.closest('.docs-code').querySelector('code').textContent);b.textContent='Copied';setTimeout(()=>{b.textContent='Copy'},1600)}catch{}})})"

const TITLE = 'Handset · Free, open source business phone system'
const SHARE = `${identity.runSite}/site/share.jpg`
const FONTS = ['/fonts/archivo/archivo-latin-wght.woff2', '/fonts/ibm-plex-sans/ibm-plex-sans-latin-wght.woff2']

/** The font preloads and share card every run-site page carries, Base's pages included (they bring their own icon links). */
const sharedHead = (title: string, description: string) => <>
  <meta name="theme-color" content="#060606" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Handset" />
  <meta property="og:title" content={title} />
  <meta property="og:description" content={description} />
  <meta property="og:image" content={SHARE} />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Handset picks up: x-ray telephone handsets and coiled cords on black" />
  <meta name="twitter:card" content="summary_large_image" />
  {FONTS.map(href => <link key={href} rel="preload" href={href} as="font" type="font/woff2" crossOrigin="anonymous" />)}
</>

export function sitePages({ styles, contract }: SiteContext): SiteBuild {
  const data: RunData = { ...run, pricing: runPricing }
  const document = (title: string, description: string, body: ReactElement, script = '') => '<!doctype html>' + renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        {sharedHead(title, description)}
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" type="image/svg+xml" href="/favicon-32.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="stylesheet" href="/fonts/fonts.css" />
        {styles.map(href => <link key={href} rel="stylesheet" href={href} />)}
      </head>
      <body>{body}{script ? <script dangerouslySetInnerHTML={{ __html: script }} /> : null}</body>
    </html>,
  )
  // Base's pages keep their composition and wear the site: its tokens, header and footer, and no floor art.
  const site = { ...identity, band: undefined }
  const base = (page: 'run' | 'contract' | 'not-found', html: string, title: string, description: string) => wearSite(html, { page, styles, head: renderToStaticMarkup(sharedHead(title, description)) })
  const docs = (slug?: string) => docsHead(slug)
  const us = contract && usContract(contract)
  return {
    pages: [
      { path: '/', html: document(TITLE, TITLE, <Landing />) },
      { path: '/run', html: base('run', runPageHtml(site, data, us), 'Run Handset', 'Run Handset on your computer. 100% free and open source.') },
      ...(us ? [{ path: '/contract', html: base('contract', contractPageHtml(site, data, us), 'Contract · Handset', 'What Handset is being built to do, and how much of it the code does today.') }] : []),
      { path: '/docs', html: document(docs().title, docs().description, <DocsIndex />) },
      ...docsPages.map(page => ({ path: `/docs/${page.slug}`, html: document(docs(page.slug).title, docs(page.slug).description, <DocsArticle slug={page.slug} />, COPY) })),
      { path: '/404', html: base('not-found', siteNotFoundHtml(site, data, us), 'Not found · Handset', TITLE) },
    ],
    assets: ['rer-theme.css', 'fonts', 'brand', 'site', 'favicon.ico', 'favicon-32.svg', 'apple-touch-icon.png'],
  }
}
