import { UPDATE_PUBLIC_KEY } from './update-key.js';

export const RELEASE_ROOT = 'https://github.com/DarkPoesidon/Abraneh/releases';
// GitHub keeps this number through a rename or a transfer, which the name above does not survive.
// It is lost only if the repository is deleted. Android and Windows use the same number.
export const REPOSITORY_ID = 1436869002;
export const UPDATER_MARKER = 'wihm-updater-v1';
export const assetTypes: Record<string,string> = { html:'text/html; charset=utf-8', css:'text/css; charset=utf-8', js:'application/javascript; charset=utf-8', json:'application/json; charset=utf-8', svg:'image/svg+xml', woff2:'font/woff2', txt:'text/plain; charset=utf-8', md:'text/markdown; charset=utf-8' };
export interface UpdateBundle {
  format: 1; version: string; minimumUpdaterVersion: string; sourceCommit: string; notes: string;
  files: Record<string,string>;
}
export const validVersion = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.length < 32;
export function newer(a: string,b: string) { const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false; }
export const decode64 = (value: string) => Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export function encode64(bytes: Uint8Array) { let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value); }
export async function sha256(value: Uint8Array | string) { const bytes=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join(''); }
export async function limitedBytes(response: Response,maximum: number): Promise<Uint8Array> {
  if(!response.ok)throw new Error('دریافت بستهٔ رسمی کامل نشد. بعداً دوباره تلاش کنید.');
  const reader=response.body?.getReader();if(!reader)throw new Error('بستهٔ دریافتی خالی است.');
  const chunks:Uint8Array[]= [];let length=0;
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>maximum){await reader.cancel();throw new Error('حجم بسته بیش از حد مجاز است.');}chunks.push(value);}
  const result=new Uint8Array(length);let offset=0;for(const part of chunks){result.set(part,offset);offset+=part.length;}return result;
}
export async function verifyBundle(bytes: Uint8Array,signature: string,keyData=UPDATE_PUBLIC_KEY): Promise<UpdateBundle> {
  const fail=()=>{throw new Error('امضای بستهٔ به‌روزرسانی معتبر نیست؛ هیچ تغییری انجام نشد.');};
  if(!/^[A-Za-z0-9+/]{86}==$/.test(signature.trim()))return fail();
  const key=await crypto.subtle.importKey('spki',decode64(keyData),{name:'Ed25519'},false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',key,decode64(signature.trim()),new Uint8Array(bytes)))return fail();
  let bundle:UpdateBundle;try{bundle=JSON.parse(new TextDecoder().decode(bytes));}catch{return fail();}
  if(bundle.format!==1||!validVersion(bundle.version)||!validVersion(bundle.minimumUpdaterVersion)||!/^[a-f0-9]{40}$/.test(bundle.sourceCommit)||typeof bundle.notes!=='string'||bundle.notes.length>16000||!bundle.files||typeof bundle.files!=='object'||Array.isArray(bundle.files))return fail();
  const files=Object.entries(bundle.files);if(files.length>300||files.length<5)return fail();
  for(const [name,value] of files){
    if(!(name==='worker.mjs'||name==='updater.mjs'||name==='schema.sql'||/^migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(name)||(/^public\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(name)&&assetTypes[name.split('.').at(-1)!])))return fail();
    if(typeof value!=='string'||value.length>3_000_000||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))return fail();
    try{if(encode64(decode64(value))!==value)return fail();}catch{return fail();}
  }
  for(const name of ['worker.mjs','updater.mjs','schema.sql','public/index.html','public/sw.js'])if(!Object.hasOwn(bundle.files,name))return fail();
  return bundle;
}
/** The signed update files. The signature is checked afterwards, so where they come from does not matter for trust. */
export async function releaseFiles(version:string|undefined,fetcher:typeof fetch):Promise<[Uint8Array,Uint8Array]> {
  const options={headers:{'User-Agent':'WIHM-Cloudflare-Updater'},signal:AbortSignal.timeout(30_000)};
  const download=(url:(name:string)=>string)=>Promise.all([fetcher(url('wihm-update.json'),options).then(r=>limitedBytes(r,6_000_000)),fetcher(url('wihm-update.sig'),options).then(r=>limitedBytes(r,200))]);
  const base=version?`${RELEASE_ROOT}/download/installer-v${version}`:`${RELEASE_ROOT}/latest/download`;
  try { return await download(name=>base+'/'+name); }
  catch(byName) {
    // The name failed, as after a rename whose redirect is gone. The API finds the release by its number.
    const response=await fetcher(`https://api.github.com/repositories/${REPOSITORY_ID}/releases/${version?'tags/installer-v'+version:'latest'}`,{...options,headers:{...options.headers,Accept:'application/vnd.github+json'}});
    if(!response.ok){await response.body?.cancel();throw byName;}
    const assets:any[]=(JSON.parse(new TextDecoder().decode(await limitedBytes(response,1_000_000))) as any)?.assets;
    const link=(name:string)=>{const url=Array.isArray(assets)?assets.find(asset=>asset?.name===name)?.browser_download_url:null;if(typeof url!=='string'||!url.startsWith('https://'))throw byName;return url;};
    return download(link);
  }
}
export async function downloadBundle(version?:string,fetcher:typeof fetch=fetch) {
  if(version&&!validVersion(version))throw new Error('شمارهٔ نسخه معتبر نیست.');
  const base=version?`${RELEASE_ROOT}/download/installer-v${version}`:`${RELEASE_ROOT}/latest/download`;
  const [payload,signature]=await releaseFiles(version,fetcher);
  const bundle=await verifyBundle(payload,new TextDecoder().decode(signature));
  if(version&&version!==bundle.version)throw new Error('نسخهٔ بسته با نسخهٔ انتخاب‌شده یکسان نیست.');
  return {bundle,digest:await sha256(payload)};
}
