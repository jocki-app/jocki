import {spawnSync} from "node:child_process";
const result=spawnSync(process.execPath,["registries/jocki-content-types/generate.mjs",...process.argv.slice(2)],{stdio:"inherit"});
if(result.status!==0)process.exit(result.status ?? 1);
