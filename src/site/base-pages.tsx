// Base's /run, /contract and not-found pages (src/base, copied unchanged) wearing the run site's chrome: the site's
// stylesheets after Base's own style, the site header in place of Base's bar, and the site footer after the page.
// Each change must find exactly the markup it replaces, so a Base update that moves it stops the build instead of
// shipping a page without the site's header or footer.
import { renderToStaticMarkup } from 'react-dom/server'
import { SiteFooter } from './shell/SiteFooter'
import { SiteHeader } from './shell/SiteHeader'

const once = (html: string, pattern: RegExp, replacement: string, what: string) => {
  const found = html.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))
  if (found?.length !== 1) throw new Error(`Base page: expected one ${what}, found ${found?.length ?? 0}.`)
  return html.replace(pattern, replacement)
}

export function wearSite(html: string, { page, styles, head }: { page: 'run' | 'contract' | 'not-found'; styles: string[]; head: string }): string {
  let out = once(html, /<\/head>/, `${head}${styles.map(href => `<link rel="stylesheet" href="${href}">`).join('')}</head>`, 'head')
  out = once(out, /<body>/, `<body class="base-page ${page}-page">`, 'body')
  out = once(out, /<header class="bar">[\s\S]*?<\/header>/, renderToStaticMarkup(<SiteHeader current={page === 'contract' ? 'contract' : undefined} />), 'Base header')
  if (page === 'contract') {
    out = once(out, /<footer class="foot">[\s\S]*?<\/footer>/, '', 'contract footer')
    // An evidence path wraps only after a slash, where Base puts its <wbr>, never inside a name such as handset-auth-browser.mjs.
    out = out.replace(/<code class="path">([\s\S]*?)<\/code>/g, (_, path: string) => `<code class="path">${path.split('<wbr>').map(part => `<span class="nw">${part}</span>`).join('<wbr>')}</code>`)
  }
  return once(out, /<\/main>/, `</main>${renderToStaticMarkup(<SiteFooter />)}`, 'main')
}
