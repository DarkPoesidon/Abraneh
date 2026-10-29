import {readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
const directory='dist/WIHM-Installer/payload';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const files={};
async function collect(root,prefix=''){for(const item of await readdir(root,{withFileTypes:true})){const name=prefix+item.name;if(item.isSymbolicLink())throw Error('Links are not update payloads');if(item.isDirectory())await collect(join(root,item.name),name+'/');else if(item.isFile()&&name!=='release.json')files[name]=(await readFile(join(root,item.name))).toString('base64');}}
await collect(directory);
const sourceCommit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('Missing source commit');
const notes=await readFile(`docs/releases/${version}.fa.md`,'utf8');
const bundle={format:1,version,minimumUpdaterVersion:'1.3.0',sourceCommit,notes:notes.slice(0,16000),files};
const bytes=Buffer.from(JSON.stringify(bundle));
if(bytes.length>6_000_000)throw Error('Update payload exceeds the verified size limit');
await writeFile('dist/wihm-update.json',bytes);
const secret=process.env.WIHM_UPDATE_SIGNING_KEY;
if(secret){
  const key=createPrivateKey(secret),publicKey=createPublicKey(key).export({type:'spki',format:'der'}).toString('base64');
  const pinned=(await readFile('src/update-key.ts','utf8')).match(/UPDATE_PUBLIC_KEY = '([^']+)'/)[1];
  if(publicKey!==pinned)throw Error('Release signing key does not match the pinned trust anchor');
  await writeFile('dist/wihm-update.sig',sign(null,bytes,key).toString('base64')+'\n');
  console.log(`Signed update payload: ${version}, ${Object.keys(files).length} files, ${bytes.length} bytes.`);
}else{
  if(process.env.GITHUB_REF_TYPE==='tag')throw Error('A tagged release requires WIHM_UPDATE_SIGNING_KEY');
  await rm('dist/wihm-update.sig',{force:true});
  console.log(`Unsigned development update payload: ${version}; release signing is required in CI.`);
}
