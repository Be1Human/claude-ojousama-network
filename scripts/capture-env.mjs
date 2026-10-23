#!/usr/bin/env node
// Run this in the SAME terminal used to launch Claude Code. No tokens are read.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pickNetworkEnv } from '../src/core/profile.js';
const destination=path.resolve(process.argv[2] || 'network-profile.json');
const output={version:1,capturedAt:new Date().toISOString(),env:pickNetworkEnv(process.env)};
writeFileSync(destination,JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(`已保存网络环境快照：${destination}\n只包含网络变量，不含 API Key / OAuth Token。代理 URL 可能含密码，请在应用导入后妥善保管或删除此文件，不要上传。`);
