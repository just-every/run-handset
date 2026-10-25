import { redactionStatements, invalidateTransfersStatements } from '@runeditrun/rer/modules/portability/journal'

// Keep the public portability implementation while carrying its SQL into the
// import kit's atomic deletion batch. Reads and initialization use the real D1.
export async function checkpoint(database) {
 const wrap=(sql,params=[])=>({sql,params,bind:(...values)=>wrap(sql,values),
  first:()=>database.prepare(sql).bind(...params).first(),
  all:()=>database.prepare(sql).bind(...params).all(),
  run:()=>database.prepare(sql).bind(...params).run()})
 const db={prepare:sql=>wrap(sql)}
 return [...await redactionStatements(db),...await invalidateTransfersStatements(db)].map(({sql,params})=>({sql,params}))
}
