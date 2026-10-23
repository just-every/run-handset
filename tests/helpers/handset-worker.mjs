import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unstable_splitSqlQuery as splitSql } from 'wrangler'

// Use the exact runtime and HTTP client installed with this checkout's Wrangler.
const require = createRequire(import.meta.url)
const runtimeRequire = createRequire(require.resolve('wrangler/package.json'))
const { Miniflare, Response: WorkerResponse, convertV4MiniflareOptions } = runtimeRequire('miniflare')
const { Agent } = createRequire(runtimeRequire.resolve('miniflare'))('undici')
const root = fileURLToPath(new URL('../../', import.meta.url))

async function emittedModules(config, base) {
  // Miniflare 5 needs an explicit manifest; its v4 converter does not discover
  // imported chunks or support modulesRules. Register only emitted build files.
  const main = resolve(base, config.main)
  const rules = [...(config.rules ?? []),
    { type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] },
    { type: 'CommonJS', globs: ['**/*.cjs'] },
    { type: 'Text', globs: ['**/*.txt', '**/*.html', '**/*.sql'] },
    { type: 'Data', globs: ['**/*.bin'] },
    { type: 'CompiledWasm', globs: ['**/*.wasm'] },
  ]
  const modules = (await readdir(base, { recursive: true, withFileTypes: true }))
    .filter(file => file.isFile()).flatMap(file => {
      const path = join(file.parentPath, file.name)
      const rule = rules.find(rule => rule.globs.some(glob => matchesGlob(relative(base, path), glob)))
      return rule ? [{ path, type: rule.type }] : []
    })
  if (!modules.some(module => module.path === main)) throw new Error('Emitted Worker entry is missing')
  return modules.sort((a, b) => a.path === main ? -1 : b.path === main ? 1 : a.path.localeCompare(b.path))
}

async function freePort() {
  const socket = createServer()
  await new Promise((done, fail) => socket.once('error', fail).listen(0, '127.0.0.1', done))
  const { port } = socket.address()
  await new Promise((done, fail) => socket.close(error => error ? fail(error) : done()))
  return port
}

async function migrate(db) {
  await db.prepare(`CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run()
  const directory = join(root, 'migrations/core')
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
  for (const name of files) {
    const statements = splitSql(await readFile(join(directory, name), 'utf8'))
    await db.batch([
      ...statements.map(statement => db.prepare(statement)),
      db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(name),
    ])
  }
}

async function seed(db, ownerEmail) {
  const now = Date.now()
  const operator = db.prepare(`INSERT INTO oa_operators
    (id,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?)`)
  await db.batch([
    operator.bind('synthetic-handset-1', ownerEmail, 'Mara Patel', 'owner', 'active', now),
    operator.bind('synthetic-handset-2', 'synthetic-handset-2@example.test', 'Elliot Brooks', 'member', 'inactive', now),
    db.prepare('INSERT INTO oa_bootstrap(singleton,claim_id,claimed_at) VALUES (1,?,?)')
      .bind('synthetic-handset-1', now),
    db.prepare('INSERT INTO oa_first_run(singleton,completed_by,completed_at) VALUES (1,?,?)')
      .bind('synthetic-handset-1', now),
  ])
}

/**
 * Real emitted production Worker, HTTPS socket, assets and isolated D1.
 * Browser callers use a fresh Playwright context with ignoreHTTPSErrors: true;
 * launch headless with --use-mock-keychain and --password-store=basic, real HOME.
 * mails contains raw SendGrid JSON, without transport headers or credentials.
 */
export async function openHandset({ liveMail = false, twilio = false, edges = null } = {}) {
  if (liveMail && ['MAIL_TO', 'MAIL_FROM', 'MAIL_API_KEY'].some(name => !process.env[name])) {
    throw new Error('Live mail requires MAIL_TO, MAIL_FROM and MAIL_API_KEY')
  }
  const configPath = join(root, 'dist/server/wrangler.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (!config.main || !config.assets?.directory) throw new Error('Build the Worker and assets before opening the harness')
  const base = dirname(configPath)
  const modules = await emittedModules(config, base)
  const origin = `https://127.0.0.1:${await freePort()}`
  const ownerEmail = liveMail ? process.env.MAIL_TO : 'synthetic-handset-1@example.test'
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-handset-'))
  // TLS trust is scoped to this client's loopback requests, never process-wide.
  let dispatcher = new Agent({ connect: { rejectUnauthorized: false } })
  const mails = [], twilioResources = new Map(), sourceRequests = []
  let runtime, options, db, mailFailure = false, closing
  const close = () => closing ??= (async () => {
    try { await runtime?.dispose() }
    finally {
      try { await dispatcher.close() }
      finally { await rm(directory, { recursive: true, force: true }) }
    }
  })()
  async function outboundService(request) {
    if (edges) { const answer = await edges.handle(request, WorkerResponse); if (answer) return answer }
    if(twilio && (request.url.startsWith('https://api.twilio.com/2010-04-01/Accounts/') || request.url.startsWith('https://insights.twilio.com/v1/Voice/'))) {
      sourceRequests.push({url:request.url,method:request.method})
      const mapped=twilioResources.get(request.url)
      const response=Array.isArray(mapped?.__responses)?mapped.__responses.shift():mapped
      const payload=typeof response==='function'?await response(request):response
      if(payload?.__audio){const bytes=new Uint8Array(payload.__audio);return new WorkerResponse(bytes,{status:payload.__httpStatus??200,headers:{'content-type':payload.__mime??'audio/wav','content-length':String(bytes.length)}})}
      const {__httpStatus=200,...body}=payload??{}
      return new WorkerResponse(JSON.stringify(payload?body:{code:20404,message:'Synthetic resource not found'}),{status:payload?__httpStatus:404,headers:{'content-type':'application/json'}})
    }
    const isMail = request.url === 'https://api.sendgrid.com/v3/mail/send'
    if (isMail) {
      mails.push(await request.clone().json())
      if (!liveMail) return new WorkerResponse(null, {
        status: mailFailure ? 503 : 202,
        headers: { 'x-message-id': 'synthetic-handset-6' },
      })
    }
    const response = await fetch(request.url, {
      method: request.method, headers: request.headers, redirect: 'manual',
      ...(request.body ? { body: await request.arrayBuffer() } : {}),
    })
    return new WorkerResponse(response.body ? await response.arrayBuffer() : null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    })
  }
  try {
    options = convertV4MiniflareOptions({
      name: config.name,
      rootPath: base,
      modules, modulesRoot: base,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      host: '127.0.0.1', port: Number(new URL(origin).port), https: true,
      cf: false, telemetry: { enabled: false },
      resourcePersistencePath: join(directory, 'state'),
      resourceTmpPath: join(directory, 'tmp'),
      d1Databases: { DB: 'synthetic-handset-5' },
      assets: {
        directory: resolve(base, config.assets.directory),
        binding: config.assets.binding ?? 'ASSETS',
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
        assetConfig: {
          html_handling: config.assets.html_handling,
          not_found_handling: config.assets.not_found_handling,
        },
      },
      bindings: {
        ...(twilio?{HANDSET_TWILIO_AUTH_TOKEN:'synthetic-handset-500'}:{}),
        ...(edges?{HANDSET_DIAL_ORIGIN:edges.origins.dial,HANDSET_DIAL_TOKEN:edges.secrets.dial,HANDSET_STRIPE_KEY:edges.secrets.stripe,HANDSET_ORBIT_ORIGIN:edges.origins.orbit,HANDSET_ORBIT_TOKEN:edges.secrets.orbit,HANDSET_HELPDESK_ORIGIN:edges.origins.helpdesk,HANDSET_HELPDESK_TOKEN:edges.secrets.helpdesk}:{}),
        AUTH_LOCAL: 'false', AUTH_ORIGIN: origin, OWNER_EMAIL: ownerEmail,
        SESSION_SECRET: 'synthetic-handset-7-synthetic-handset-8', INSTALLATION_KEY: randomBytes(32).toString('hex'),
        MAIL_PROVIDER: 'sendgrid',
        MAIL_FROM: liveMail ? process.env.MAIL_FROM : 'synthetic-handset-3@example.test',
        MAIL_API_KEY: liveMail ? process.env.MAIL_API_KEY : 'synthetic-handset-4',
      },
      outboundService,
    })
    runtime = new Miniflare(options)
    const ready = await runtime.ready
    if (ready.origin !== origin) throw new Error('Worker HTTPS listener did not bind the requested origin')
    db = await runtime.getD1Database('DB')
    await migrate(db)
    await seed(db, ownerEmail)
    return {
      origin, ownerEmail, mails, get db() { return db }, close, twilioResources, sourceRequests,
      async restart() {
        await runtime.dispose()
        await dispatcher.close()
        dispatcher = new Agent({ connect: { rejectUnauthorized: false } })
        runtime = new Miniflare(options)
        await runtime.ready
        db = await runtime.getD1Database('DB')
      },
      async scheduled(time = Date.now()) {
        const worker = await runtime.getWorker()
        return worker.scheduled({ scheduledTime: time, cron: '* * * * *' })
      },
      // Direct native D1 access lets expiry tests change timestamps without sleeps.
      sql: (query, ...values) => db.prepare(query).bind(...values).all(),
      request(path, options = {}) {
        const url = new URL(path, origin)
        if (url.origin !== origin) throw new Error('Harness requests must stay on its HTTPS origin')
        return fetch(url, { redirect: 'manual', ...options, dispatcher })
      },
      setMailFailure(fail = true) {
        if (liveMail) throw new Error('Mail failure injection is available only with intercepted mail')
        mailFailure = Boolean(fail)
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
