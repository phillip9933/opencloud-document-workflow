// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {healthResponse} from '../../companion/health.mjs'
test('public installer health exposes only readiness/version and never handles other API operations',()=>{let headers,body;const res={writeHead(status,value){assert.equal(status,200);headers=value},end(value){body=JSON.parse(value)}};assert.equal(healthResponse({url:'/_workflow/api/healthz',method:'GET'},res,'0.13.0'),true);assert.deepEqual(body,{service:'document-workflow',version:'0.13.0',apiVersion:1,ready:true});assert.equal(headers['Cache-Control'],'no-store');for(const request of [{url:'/_workflow/api/status',method:'GET'},{url:'/_workflow/api/healthz',method:'POST'},{url:'/_workflow/api/healthz?dump=secrets',method:'GET'}])assert.equal(healthResponse(request,res,'0.13.0'),false)})
