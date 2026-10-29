/** The trusted native RPC persists and drains the exact original identity. */
export default async function ({ name, args, who, worker }) {
 const queue=await worker('HandsetAgentJobs');
 const id=await queue.enqueue(name,args,who);
 return queue.drain(id);
}
