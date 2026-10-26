(() => {
 const form = document.querySelector('[data-prompt-author]')
 if (!form) return
 const field = form.querySelector('[data-audio-field]'), status = form.querySelector('[data-audio-status]'), source = form.elements.source
 const show = () => form.querySelectorAll('[data-source]').forEach(el => { el.hidden = el.dataset.source !== source.value })
 source.addEventListener('change', () => { field.value = ''; status.textContent = ''; show() })
 show()
 const base64 = bytes => { let out = ''; for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(out) }
 form.querySelector('[data-audio-file]').addEventListener('change', async event => {
  const file = event.target.files[0]
  field.value = file ? base64(new Uint8Array(await file.arrayBuffer())) : ''
  status.textContent = file ? `${file.name} ready to add.` : ''
 })
 // PCM16 WAV from the microphone: the server normalizes it to the carrier format.
 const wav = (chunks, rate) => {
  const length = chunks.reduce((n, c) => n + c.length, 0), out = new DataView(new ArrayBuffer(44 + length * 2))
  const put = (at, text) => [...text].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)))
  put(0, 'RIFF'); out.setUint32(4, 36 + length * 2, true); put(8, 'WAVE'); put(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true)
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); put(36, 'data'); out.setUint32(40, length * 2, true)
  let at = 44
  for (const chunk of chunks) for (const sample of chunk) { out.setInt16(at, Math.max(-1, Math.min(1, sample)) * 0x7fff, true); at += 2 }
  return new Uint8Array(out.buffer)
 }
 const start = form.querySelector('[data-record-start]'), stop = form.querySelector('[data-record-stop]'), preview = form.querySelector('[data-record-preview]')
 let session = null
 start.addEventListener('click', async () => {
  try {
   const stream = await navigator.mediaDevices.getUserMedia({ audio: true }), context = new AudioContext(), input = context.createMediaStreamSource(stream), tap = context.createScriptProcessor(4096, 1, 1), chunks = []
   tap.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
   input.connect(tap); tap.connect(context.destination)
   session = { stream, context, input, tap, chunks }
   start.disabled = true; stop.disabled = false; status.textContent = 'Recording from the microphone.'
  } catch { status.textContent = 'The microphone is not available.' }
 })
 stop.addEventListener('click', async () => {
  if (!session) return
  const { stream, context, input, tap, chunks } = session; session = null
  tap.disconnect(); input.disconnect(); stream.getTracks().forEach(t => t.stop())
  const bytes = wav(chunks, context.sampleRate); await context.close()
  field.value = base64(bytes)
  preview.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); preview.hidden = false
  start.disabled = false; stop.disabled = true; status.textContent = 'Recording ready. Preview it, then add the version.'
 })
})()
