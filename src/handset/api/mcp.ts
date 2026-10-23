import type { Definition, Tool } from '../authority/model'

const string = { type: 'string' }
const strings = { type: 'array', items: string, uniqueItems: true, maxItems: 100 }
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false })
const currentTools: Tool[] = ['case.read', 'comment.draft', 'call.paid', 'message.send', 'campaign.launch', 'number.release', 'flow.publish']
/** Only implemented doors are discoverable; scoped effects still require exact human authority. */
export function mcpTools(definition: Definition) {
 return currentTools.filter(name => definition.tools.includes(name)).map(name => ({
  name,
  description: name === 'case.read' ? 'Read an exactly selected native case' : name === 'comment.draft' ? 'Create an unpublished draft; retry with the same Idempotency-Key' : 'Prepare reviewed work; provider effect remains held until its adapter is qualified',
  inputSchema: name === 'case.read' ? schema({ caseId: string }, ['caseId']) : name === 'comment.draft' ? schema({ caseId: string, text: { type: 'string', maxLength: 4000 } }, ['caseId', 'text']) : schema({
   state: schema({ operation: { const: name }, caseId: string, caseVersion: { type: 'integer', minimum: 1 }, numberId: string, recipients: strings, amountCents: { type: 'integer', minimum: 0 }, flowRevision: string, policyRevision: string, content: { type: 'string', maxLength: 4000 } }, ['operation', 'caseId', 'caseVersion', 'policyRevision']),
   approvalId: string, standingId: string, idempotencyKey: { type: 'string', maxLength: 100 }, callerInstructions: { type: 'string', maxLength: 4000 },
  }, ['state', 'idempotencyKey']),
 }))
}
export function mcpToolResult(result: unknown) {
 return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }
}
