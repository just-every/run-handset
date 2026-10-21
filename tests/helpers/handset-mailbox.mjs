import assert from 'node:assert/strict'

// Live proof reads only the held receipt endpoint and only mail for this
// runtime/recipient after its request. Neither URL credentials nor link tokens
// are printed or saved as artifacts.
export async function receivedLink(runtime, since) {
  const url = new URL(process.env.MAILBOX_RECEIPT_URL)
  url.searchParams.set('to', runtime.ownerEmail)
  url.searchParams.set('since', String(since))
  url.searchParams.set('subject', 'Your sign-in link for Handset')
  for (let attempt = 0; attempt < 45; attempt++) {
    const response = await fetch(url)
    assert.equal(response.status, 200, 'controlled receipt mailbox is accessible')
    const { receipts } = await response.json()
    for (const receipt of receipts) {
      if (!receipt.excerpt.includes(runtime.origin + '/auth/confirm?token=')) continue
      assert.equal(receipt.auth?.dmarc, 'pass', 'receiver authenticates the configured sender')
      const link = receipt.excerpt.match(/https:\/\/[^\s<>]+\/auth\/confirm\?token=[A-Za-z0-9_-]+/)
      assert.ok(link, 'delivered native sign-in link')
      console.log(`Handset live mail delivered: receipt=${receipt.id}, receiver DMARC=pass`)
      return new URL(link[0])
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error('No delivered native sign-in link in the controlled mailbox within 90 seconds')
}
