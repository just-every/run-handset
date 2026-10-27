import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { parseContract } from '../src/base/seed-contract.mjs'

// Regenerate only the named clause journeys so parallel writers retain their
// acceptance entries. The implementation claims table always mirrors the source.
const [mode,...args]=process.argv.slice(2)
if(!['write','check'].includes(mode)||args.some((arg,index)=>index%2===0?arg!=='--clause':!/^HND-\d{3}$/.test(arg))||args.length%2)throw new Error('Use write or check with optional --clause HND-000 pairs')
const source=await readFile(new URL('../CONTRACT.md',import.meta.url),'utf8'),contract=parseContract(source)
let acceptance=await readFile(new URL('../ACCEPTANCE.md',import.meta.url),'utf8')
const selected=args.length?args.filter((_,index)=>index%2===1):[...acceptance.matchAll(/<!-- contract-docs: (HND-\d{3}) -->/g)].map(match=>match[1])
if(!selected.length)throw new Error('Name a clause to adopt with --clause HND-000')
const lines=source.split('\n'),counts=contract.counts
acceptance=acceptance.replace(/Current clause totals are \*\*\d+ done, \d+ partial and \d+ missing\*\*/,`Current clause totals are **${counts.done} done, ${counts.partial} partial and ${counts.missing} missing**`)
for(const id of selected){
 const clause=contract.clauses.find(c=>c.id===id)
 if(!clause)throw new Error('Unknown clause '+id)
 const marker='**Acceptance evidence:**',at=clause.text.indexOf(marker)
 if(at<0)throw new Error('Missing acceptance evidence in '+id)
 const evidence=lines[clause.row-1].split('|').slice(1,-1)[4].trim()
 const entry=`- **${id} — ${clause.title}. Status: ${clause.status}.** ${clause.text.slice(at+marker.length).trim()}${clause.gap?' Open scope: '+clause.gap:''}${evidence?' Evidence: '+evidence:''} <!-- contract-docs: ${id} -->`
 const pattern=new RegExp('^- \\*\\*'+id+' — [^\\n]*(?:\\n(?!- \\*\\*HND-|###? |$)[^\\n]*)*','m')
 if(!pattern.test(acceptance))throw new Error('Missing existing journey '+id)
 acceptance=acceptance.replace(pattern,()=>entry)
}
const claims='# Implementation status\n\nGenerated from CONTRACT.md. Homepage claims remain in the separate homepage document.\n\n| Clause | Status | Evidence | Gap |\n| --- | --- | --- | --- |\n'+contract.clauses.map(clause=>{
 const row=lines[clause.row-1].split('|').slice(1,-1).map(cell=>cell.trim())
 return `| ${clause.id} | ${clause.status} | ${row[4]} | ${clause.gap} |`
}).join('\n')+'\n'
const files=[['ACCEPTANCE.md',acceptance],['docs/CLAIMS.md',claims]]
for(const [path,expected] of files){
 const url=new URL('../'+path,import.meta.url)
 if(mode==='write'){await mkdir(new URL('.',url),{recursive:true});await writeFile(url,expected)}
 else if(await readFile(url,'utf8').catch(()=>null)!==expected)throw new Error(path+' is stale; run the same command with write')
}
console.log('Contract documents '+mode+' complete for '+selected.join(', '))
