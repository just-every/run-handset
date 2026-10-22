// Where the run site's links go. The run site never links an instance-only route (/signin, /setup, /app).
import run from '../run.json'

export const links = { home: '/', run: '/run', demo: 'https://demo.run-handset.com/', docs: '/docs', contract: '/contract', source: run.repository }
export const docsPath = (slug: string) => `/docs/${slug}`
