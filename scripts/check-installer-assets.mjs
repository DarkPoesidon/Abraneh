// Exercise the uploader from the built/downloaded installer, without cloud credentials.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const directory=resolve(process.argv[2] || 'dist/WIHM-Installer');
const {uploadAssets}=await import(pathToFileURL(join(directory,'deploy.mjs')).href);
assert.equal(typeof uploadAssets,'function','The packaged uploader must be available for verification.');
const expected=new Map();
async function inventory(current,prefix='') {
  for(const item of await readdir(current,{withFileTypes:true})) {
    const relative=prefix+item.name;
    assert.ok(!item.isSymbolicLink(),'Unexpected link in package: '+relative);
    if(item.isDirectory())await inventory(join(current,item.name),relative+'/');
    else {assert.ok(item.isFile());expected.set('/'+relative,await readFile(join(current,item.name)));}
  }
}
const publicDirectory=join(directory,'payload/public');await inventory(publicDirectory);
const fontPath='/fonts/Vazir-Variable.woff2';
assert.ok(expected.has(fontPath),'The actual font must be included in the deployment test.');
assert.equal(createHash('sha256').update(expected.get(fontPath)).digest('hex'),'3d7c6820aa45e4f1c569561a7dabc6472153e14ea883b5b6ef41aa764c66def0');
let cached=false,manifestCount=0,uploadCount=0;
let byHash=new Map(),seen=new Set();
const api={async request(path,options) {
  assert.equal(options.method,'POST');
  if(path==='/accounts/test-account/workers/scripts/test-worker/assets-upload-session') {
    manifestCount++;const manifest=options.json.manifest;
    assert.deepEqual(Object.keys(manifest).sort(),[...expected.keys()].sort());
    byHash=new Map();seen=new Set();
    for(const [name,content] of expected) {
      assert.ok(!name.includes('\\'));
      const hash=createHash('sha256').update(content.toString('base64')+extname(name).slice(1)).digest('hex').slice(0,32);
      assert.deepEqual(manifest[name],{hash,size:content.length});byHash.set(hash,{name,content});
    }
    const hashes=[...byHash.keys()],buckets=[];
    for(let i=0;i<hashes.length;i+=3)buckets.push(hashes.slice(i,i+3));
    return {result:{jwt:'test-upload-session',buckets:cached?[]:buckets}};
  }
  assert.equal(path,'/accounts/test-account/workers/assets/upload?base64=true');
  assert.equal(options.token,'test-upload-session');uploadCount++;
  for(const [hash,file] of options.form) {
    assert.ok(byHash.has(hash));assert.ok(!seen.has(hash));seen.add(hash);
    const original=byHash.get(hash);
    assert.deepEqual(Buffer.from(await file.text(),'base64'),original.content);
    if(original.name===fontPath)assert.equal(file.type,'font/woff2');
  }
  return {result:seen.size===byHash.size?{jwt:'test-assets-complete'}:{}};
}};
assert.equal(await uploadAssets(api,'test-account','test-worker',publicDirectory),'test-assets-complete');
assert.equal(seen.size,byHash.size);assert.ok(uploadCount>1,'Exercise multipart bucket iteration.');
cached=true;const previousUploads=uploadCount;
assert.equal(await uploadAssets(api,'test-account','test-worker',publicDirectory),'test-upload-session');
assert.equal(uploadCount,previousUploads);assert.equal(manifestCount,2);
console.log(`Packaged asset upload passed: ${expected.size} paths, nested Vazir font, exact bytes/MIME, multipart buckets and cached retry; no Cloudflare requests.`);
