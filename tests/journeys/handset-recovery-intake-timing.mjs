import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { intakeFixture } from '../helpers/handset-recovery-intake.mjs'

const f=await intakeFixture()
try {
 await f.approve()
 const call=f.call(199),start=performance.now(),response=await call.send()
 assert.equal(response.status,200,await response.clone().text())
 const receipt=await response.json(),rows=(await f.get()).cases,task=rows.find(r=>r.call_record_id===receipt.recordId),elapsedMs=performance.now()-start
 assert.ok(task);assert.equal(task.owner_id,'synthetic-handset-1');assert.equal(task.state,'open')
 assert.ok(elapsedMs<60000,'owned recovery is visible within one minute of the final missed callback')
 await call.send();await f.runtime.restart();await call.send()
 assert.equal((await f.get()).cases.length,1)
 assert.equal((await f.get('/api/handset/consent')).permissions.length,0)
 assert.equal((await f.get('/api/handset/callbacks')).callbacks.length,0)
 assert.equal(f.runtime.sourceRequests.filter(r=>r.method==='POST').length,0)
 console.log(JSON.stringify({journey:'One final unanswered call creates owned work without contact inside 60 seconds',sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),elapsedMs,tasks:1,customerContact:0,officialProviderEdge:'substituted',realHandsetReceipt:false}))
}finally{await f.runtime.close()}
