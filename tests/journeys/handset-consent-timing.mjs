import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { consentFixture,oneReplyJourney,ownedTaskWithinMinute } from '../helpers/handset-consent.mjs'

// Run outside Verify, through the heavy slot, on the clean candidate commit.
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'','timing journey requires a clean candidate')
const candidate=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),f=await consentFixture()
try {
 const {elapsed}=await oneReplyJourney(f)
 const taskOnly=[]
 for(const [n,choice] of [[10,'declined'],[11,'timeout'],[12,'disconnected']]) {
  const call=await f.start(n)
  if(choice!=='disconnected')await call.decision(choice==='declined'?'2':null)
  const began=performance.now()
  if(choice==='disconnected')assert.equal((await call.disconnect()).status,200)
  else await call.missed()
  const report=await f.get(),outcome=await ownedTaskWithinMinute(f,call,report,began)
  assert.equal(outcome.text_id,null);assert.equal(f.receiver.sent.length,1)
  const permission=report.permissions.find(p=>p.call_id===call.call.id)
  assert.equal(permission.state,'declined');assert.equal(JSON.parse(permission.event).marketingEnrollment,false)
  taskOnly.push({choice,elapsedMilliseconds:performance.now()-began})
 }
 console.log(JSON.stringify({runId:process.env.HANDSET_JOURNEY_RUN_ID??'handset-consent-timing',candidate,journey:'One missed call reaches one confirmed Twilio edge send within 60 seconds',elapsedMilliseconds:elapsed,taskOnly,providerCreates:f.receiver.sent.length,realHandsetReceipt:false}))
} finally {await f.runtime.close()}
