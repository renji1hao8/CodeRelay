import assert from 'node:assert/strict';
import {acceptsNetworkRequest} from '../src/network-access.ts';
assert.equal(acceptsNetworkRequest(false,'/api/pair/claim','127.0.0.1'),false);
assert.equal(acceptsNetworkRequest(false,'/api/pair/claim','0.0.0.0'),true);
assert.equal(acceptsNetworkRequest(false,'/api/pair/start','0.0.0.0'),false);
assert.equal(acceptsNetworkRequest(false,'/api/elevated/request','0.0.0.0'),false);
assert.equal(acceptsNetworkRequest(false,'/api/fs/read','0.0.0.0'),true); // Device auth follows this guard.
assert.equal(acceptsNetworkRequest(true,'/api/pair/start','127.0.0.1'),true);
const original=process.env.REMOTE_CC_ROOTS;delete process.env.REMOTE_CC_ROOTS;
const {config}=await import('../src/config.ts');assert.deepEqual(config.roots,[config.listDir]);
if(original!==undefined)process.env.REMOTE_CC_ROOTS=original;
console.log('OK restricted file roots, explicit LAN mode and local-only privileged entry points');
