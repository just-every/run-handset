import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { consentFixture,oneReplyJourney } from '../helpers/handset-consent.mjs'

// Run outside Verify, through the heavy slot, on the clean candidate commit.
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'','timing journey requires a clean candidate')
const candidate=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),f=await consentFixture()
try {
 const {elapsed}=await oneReplyJourney(f)
 console.log(JSON.stringify({runId:process.env.HANDSET_JOURNEY_RUN_ID??'handset-consent-timing',candidate,journey:'One missed call reaches one confirmed Twilio edge send within 60 seconds',elapsedMilliseconds:elapsed,providerCreates:f.receiver.sent.length,realHandsetReceipt:false}))
} finally {await f.runtime.close()}
