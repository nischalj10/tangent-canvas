import{spawn}from'node:child_process';import fs from'node:fs';import path from'node:path';import os from'node:os';import{fileURLToPath}from'node:url';
import{requireLivePageUrl}from'./live-page-target.mjs';
requireLivePageUrl();
const directory=path.dirname(fileURLToPath(import.meta.url)),base=path.resolve(directory,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-full-native-'));
const child=spawn(path.join(base,'node_modules/.bin/electron'),[path.join(directory,'native-app-child.mjs'),'--hidden'],{cwd:base,detached:true,env:{...process.env,TANGENT_NATIVE_REPORT_DIR:path.resolve(base,'../../work/full-native-release-proof'),TANGENT_DATA_DIR:path.join(profile,'app-data'),TANGENT_ALLOW_MULTIPLE:'1',TANGENT_E2E:'1',TANGENT_TEST_CODEX_BINARY:path.join(base,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(profile,'peer.json')},stdio:['ignore','pipe','pipe']});
let log='';for(const stream of[child.stdout,child.stderr])stream.on('data',data=>{log+=data.toString();process.stdout.write(data)});
const timer=setTimeout(()=>{console.error('External30s watchdog: terminating own full-app smoke process group');try{process.kill(-child.pid,'SIGKILL')}catch{}},29000);
child.on('exit',(code,signal)=>{clearTimeout(timer);fs.mkdirSync(path.resolve(base,'../../work/full-native-release-proof'),{recursive:true});fs.writeFileSync(path.resolve(base,'../../work/full-native-release-proof/run.log'),log);fs.rmSync(profile,{recursive:true,force:true});console.log(JSON.stringify({code,signal}));process.exitCode=code??2});
