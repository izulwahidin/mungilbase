// k6 load test for a running MungilBase deployment.
//
//   BASE_URL=https://api.example.com TABLE=notes RATE=200 DURATION=60s \
//     k6 run scripts/loadtest.k6.js
//
// Seed first:
//   npx tsx scripts/seed.ts --config ./bench.config.json --table notes --rows 100000
//
// This drives a realistic mix: an indexed list, a filtered list, and health.
// Writes are intentionally excluded; test them in a separate scenario with a
// dedicated database so a read benchmark cannot fill the disk.

import http from 'k6/http'
import { check } from 'k6'

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const TABLE = __ENV.TABLE || 'notes'
const RATE = Number(__ENV.RATE || 100)
const DURATION = __ENV.DURATION || '30s'
const BEARER = __ENV.BEARER || ''

export const options = {
  scenarios: {
    mixed_reads: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(10, Math.ceil(RATE / 4)),
      maxVUs: Math.max(50, RATE * 2),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    dropped_iterations: ['count<1'],
  },
}

const params = BEARER ? { headers: { Authorization: `Bearer ${BEARER}` } } : {}

const paths = [
  `/api/v1/${TABLE}?limit=20`,
  `/api/v1/${TABLE}?filter=done%20%3D%3D%20true&sort=-created_at&limit=20`,
  '/health',
]

export default function () {
  const responses = http.batch(paths.map((path) => ['GET', `${BASE_URL}${path}`, null, params]))

  for (const response of responses) {
    check(response, {
      'status below 400': (result) => result.status < 400,
      'json content type': (result) => (result.headers['Content-Type'] || '').includes('application/json'),
    })
  }
}
