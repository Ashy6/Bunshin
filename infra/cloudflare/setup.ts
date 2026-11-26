import { spawnSync } from "node:child_process";

const commands=[
  ["wrangler","d1","create","ai-bunshin"],
  ["wrangler","r2","bucket","create","ai-bunshin-assets"],
  ["wrangler","kv","namespace","create","CACHE"],
  ["wrangler","queues","create","ai-bunshin-ingestion"],
  ["wrangler","queues","create","ai-bunshin-ingestion-dlq"],
  ["wrangler","vectorize","create","ai-bunshin-knowledge-v1","--dimensions=1536","--metric=cosine"],
];

console.log("Creating Cloudflare resources. Existing-resource errors can be ignored after IDs are verified.\n");
for(const [command,...args] of commands){
  console.log(`> ${command} ${args.join(" ")}`);
  const result=spawnSync(command,args,{stdio:"inherit",shell:false});
  if(result.error)console.warn(`Could not execute ${command}: ${result.error.message}`);
}
console.log("\nCopy the returned IDs into apps/web/wrangler.jsonc and apps/admin/wrangler.jsonc, then configure Worker Secrets.");
