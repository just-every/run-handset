// Control only the isolated test clocks; the emitted application and its quiet-hour
// policy are unchanged. Advancing time keeps provider duration checks meaningful.
export function callingClock(fixedTime) {
 const NativeDate = globalThis.Date, target = new NativeDate()
 target.setUTCHours(18, 0, 0, 0)
 const offset = target.getTime() - NativeDate.now()
 let selectedTime = fixedTime
 const nowExpression = () => Number.isSafeInteger(selectedTime) ? String(selectedTime) : `NativeDate.now() + ${offset}`
 const expression = () => `(() => {
  const NativeDate = globalThis.__handsetNativeDate ??= globalThis.Date;
  globalThis.Date = class extends NativeDate {
   constructor(...args) { super(...(args.length ? args : [${nowExpression()}])); }
   static now() { return ${nowExpression()}; }
  };
 })()`
 globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [Number.isSafeInteger(selectedTime) ? selectedTime : NativeDate.now() + offset])) }
  static now() { return Number.isSafeInteger(selectedTime) ? selectedTime : NativeDate.now() + offset }
 }
 return {
  set(time) { if (!Number.isSafeInteger(time)) throw new Error('Invalid test clock'); selectedTime = time },
  restore() { globalThis.Date = NativeDate },
  async attach(runtime) {
   const inspector = await runtime.getInspectorURL()
   const discovery = new URL('/json', inspector); discovery.protocol = 'http:'
   const targets = await (await fetch(discovery)).json()
   const target = targets.find(t => t.id?.startsWith('core:user:')) ?? targets[0]
   if (!target?.webSocketDebuggerUrl) throw new Error('Test Worker inspector unavailable')
   const socket = new WebSocket(target.webSocketDebuggerUrl)
   try {
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    let contextId
    const context = new Promise((resolve, reject) => {
     const timeout = setTimeout(() => reject(new Error('Test Worker context unavailable: ' + target.id)), 5000)
     socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.executionContextCreated') { clearTimeout(timeout); contextId = message.params.context.id; resolve() }
     })
    })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
    await context
    const answer = new Promise((resolve, reject) => {
     const timeout = setTimeout(() => reject(new Error('Test clock attachment timed out')), 5000)
     socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id === 2) { clearTimeout(timeout); resolve(message) } })
    })
    socket.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: expression(), contextId, returnByValue: true } }))
    const result = await answer
    if (result.error || result.result?.exceptionDetails) throw new Error('Test clock attachment refused: ' + JSON.stringify(result.error ?? result.result.exceptionDetails))
   } finally { socket.close() }
  },
 }
}
