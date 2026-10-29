import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createPublicKey,verify} from 'node:crypto';
import {build} from 'esbuild';
const directory=resolve(process.argv[2]||'dist'),payload=await readFile(join(directory,'wihm-update.json'));
const bundle=JSON.parse(payload),trust=(await readFile('src/update-key.ts','utf8')).match(/UPDATE_PUBLIC_KEY = '([^']+)'/)[1];
let signature=null;try{signature=await readFile(join(directory,'wihm-update.sig'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(signature){assert.ok(verify(null,payload,createPublicKey({key:Buffer.from(trust,'base64'),type:'spki',format:'der'}),Buffer.from(signature.trim(),'base64')),'Release signature must match the pinned key');const source=await build({entryPoints:['src/update-bundle.ts'],bundle:true,write:false,format:'esm',platform:'node'});const verifier=await import('data:text/javascript;base64,'+Buffer.from(source.outputFiles[0].text).toString('base64'));await verifier.verifyBundle(payload,signature);}
else assert.notEqual(process.env.GITHUB_REF_TYPE,'tag','Tagged packages must be signed');
assert.equal(bundle.format,1);assert.equal(bundle.version,JSON.parse(await readFile('package.json','utf8')).version);
const expected=new Map();const root=resolve(process.argv[3]||'dist/WIHM-Installer/payload');
async function collect(current,prefix=''){for(const item of await readdir(current,{withFileTypes:true})){assert.ok(!item.isSymbolicLink());const name=prefix+item.name;if(item.isDirectory())await collect(join(current,item.name),name+'/');else if(name!=='release.json')expected.set(name,await readFile(join(current,item.name)));}}
await collect(root);assert.deepEqual(Object.keys(bundle.files).sort(),[...expected.keys()].sort());
for(const [name,bytes]of expected)assert.deepEqual(Buffer.from(bundle.files[name],'base64'),bytes,'Payload differs: '+name);
console.log(`${signature?'Signed':'Development'} update payload verified against ${expected.size} actual installer files; version ${bundle.version}.`);
