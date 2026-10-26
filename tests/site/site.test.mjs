// The run site (run-handset.com) as `rer build --site` writes it: a visitor reaches /run from the homepage's primary
// action, every page's links and files resolve inside the site, no page links an instance-only route, and no page
// outside /docs carries what a local run prints (the held-out site check's no-owner-data rule).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../..', import.meta.url).pathname
const site = join(root, 'dist/site')
const pages = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? pages(join(dir, entry.name)) : entry.name.endsWith('.html') ? [join(dir, entry.name)] : [])
const served = path => [path, `${path}.html`, join(path, 'index.html')].some(candidate => existsSync(join(site, candidate)) && !candidate.endsWith('/'))
const attrs = (html, name) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'gi'))].map(match => match[1].replaceAll('&amp;', '&'))
const anchors = html => [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(([, href, inner]) => ({ href, text: inner.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s+/g, ' ').trim() }))

test('the run site builds with named story proofs, its Run Handset actions open /run, and every link and file resolves', () => {
  execFileSync(join(root, 'node_modules/.bin/rer'), ['build', '--site'], { cwd: root, stdio: 'pipe' })
  const home = readFileSync(join(site, 'index.html'), 'utf8')
  // A visitor using the document outline can identify each story and read its proof as text.
  // This follows the rendered public page without pinning section names, order or marketing copy.
  for (const [, attrs, content] of home.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/g)) {
    const label = attrs.match(/aria-label="([^"]+)"/)
    const labelledBy = attrs.match(/aria-labelledby="([^"]+)"/)
    assert.ok(label || labelledBy, 'every homepage story has an accessible name')
    if (labelledBy) assert.ok(content.includes(`id="${labelledBy[1]}"`), 'the story heading is present in its document region')
    assert.ok(content.replace(/<[^>]+>/g, '').trim(), 'the story proof is readable without loading an image')
  }
  const runs = anchors(home).filter(a => /^Run Handset\b/.test(a.text))
  assert.ok(runs.length > 0, 'the homepage leads with Run Handset')
  for (const action of runs) assert.equal(action.href, '/run', `"${action.text}" opens /run`)
  for (const path of ['run', 'docs', 'contract']) assert.ok(served(path), `/${path} is built`)
  const all = pages(site)
  for (const file of all) {
    const html = readFileSync(file, 'utf8'), where = relative(site, file)
    const refs = [...attrs(html, 'href'), ...attrs(html, 'src'), ...attrs(html, 'srcset').flatMap(set => set.split(',').map(part => part.trim().split(/\s+/)[0]))]
    for (const ref of refs.filter(ref => ref.startsWith('/') && !ref.startsWith('//'))) {
      const path = decodeURIComponent(ref.split(/[?#]/)[0])
      assert.doesNotMatch(path, /^\/(signin|login|sign-in|setup|app|auth|api|health)(\/|$)/, `${where} links the instance-only ${path}`)
      if (path !== '/') assert.ok(served(path), `${where} names ${path}, which the site does not serve`)
    }
    if (!where.startsWith('docs')) {
      assert.doesNotMatch(html, /\bRER_(?:OPEN|READY|SIGNED_IN|SITE)\b/, `${where} prints a rer dev output line`)
      assert.doesNotMatch(html, /\b(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\b/, `${where} names a loopback address`)
      assert.doesNotMatch(html, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.test\b/, `${where} names a local dev identity`)
    }
  }
})

test('/docs opens every page it lists, and each page links back to the docs home', () => {
  const index = readFileSync(join(site, 'docs.html'), 'utf8')
  const listed = anchors(index).map(a => a.href).filter(href => /^\/docs\/[a-z0-9-]+$/.test(href))
  assert.ok(listed.length > 0, '/docs lists its pages')
  for (const href of new Set(listed)) {
    assert.ok(served(href), `${href} is built`)
    assert.ok(anchors(readFileSync(join(site, `${href.slice(1)}.html`), 'utf8')).some(a => a.href === '/docs'), `${href} links back to /docs`)
  }
})
