/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
import { Env } from './types.js';
export async function serverOrigin(env:Env,fallback:string){
  const current=await env.DB.prepare("SELECT value FROM site_settings WHERE key='server_origin'").first<{value:string}>();if(current)return current.value;
  await env.DB.prepare("INSERT OR IGNORE INTO site_settings(key,value) SELECT 'server_origin',COALESCE((SELECT value FROM site_settings WHERE key IN ('discovery_origin','secure_origin') AND value<>'' ORDER BY key LIMIT 1),?)").bind(fallback).run();
  return (await env.DB.prepare("SELECT value FROM site_settings WHERE key='server_origin'").first<{value:string}>())!.value;
}
