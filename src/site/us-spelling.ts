// Handset is a US product: what the run site prints from the seed's own documents reads in US spelling.
// CONTRACT.md stays as lane ct wrote it; the /contract page shows its clause titles and gaps with these words in US form.
import type { SeedContract } from '../base/seed-contract.mjs'

const words: Record<string, string> = { defence: 'defense', Defence: 'Defense', licence: 'license', Licence: 'License', colour: 'color', behaviour: 'behavior', organisation: 'organization', cancelled: 'canceled' }
const pattern = new RegExp(`\\b(${Object.keys(words).join('|')})\\b`, 'g')

export const usSpelling = (text: string) => text.replace(pattern, word => words[word])

/** The contract with every printed clause field in US spelling; ids, statuses and lines unchanged. */
export function usContract(contract: SeedContract): SeedContract {
  return {
    ...contract,
    target: { ...contract.target, category: usSpelling(contract.target.category), replaces: usSpelling(contract.target.replaces), firstBuyer: usSpelling(contract.target.firstBuyer), alsoBeats: contract.target.alsoBeats && usSpelling(contract.target.alsoBeats) },
    areas: contract.areas.map(area => ({ ...area, name: usSpelling(area.name) })),
    clauses: contract.clauses.map(clause => ({ ...clause, title: usSpelling(clause.title), gap: usSpelling(clause.gap), area: usSpelling(clause.area), text: usSpelling(clause.text) })),
  }
}
