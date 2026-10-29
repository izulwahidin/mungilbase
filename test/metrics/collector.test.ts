import { describe, expect, it } from 'vitest'
import { MetricsCollector } from '../../src/metrics/collector.js'

describe('MetricsCollector', () => {
  it('renders request counters, statuses and a cumulative histogram', () => {
    const metrics = new MetricsCollector()
    metrics.observe('GET', '/api/v1/posts', 200, 12)
    metrics.observe('GET', '/api/v1/posts', 200, 60)
    metrics.observe('POST', '/api/v1/posts', 403, 4)
    metrics.authFailure('unauthorized')
    metrics.authFailure('rate_limited')
    metrics.ruleDenial('posts', 'create')

    const text = metrics.render({ version: '1.2.3' })

    expect(text).toContain('# TYPE mungil_http_requests_total counter')
    expect(text).toContain(
      'mungil_http_requests_total{method="GET",route="/api/v1/posts",status="200"} 2',
    )
    expect(text).toContain(
      'mungil_http_requests_total{method="POST",route="/api/v1/posts",status="403"} 1',
    )
    expect(text).toContain('mungil_auth_failures_total{reason="unauthorized"} 1')
    expect(text).toContain('mungil_auth_failures_total{reason="rate_limited"} 1')
    expect(text).toContain('mungil_rule_denials_total{table="posts",operation="create"} 1')
    expect(text).toContain(
      'mungil_http_request_duration_ms_bucket{method="GET",route="/api/v1/posts",le="25"} 1',
    )
    expect(text).toContain(
      'mungil_http_request_duration_ms_bucket{method="GET",route="/api/v1/posts",le="100"} 2',
    )
    expect(text).toContain(
      'mungil_http_request_duration_ms_bucket{method="GET",route="/api/v1/posts",le="+Inf"} 2',
    )
    expect(text).toContain('mungil_http_request_duration_ms_sum{method="GET",route="/api/v1/posts"} 72.00')
    expect(text).toContain('mungil_http_request_duration_ms_count{method="GET",route="/api/v1/posts"} 2')
    expect(text).toContain('mungil_build_info{version="1.2.3"} 1')
  })

  it('escapes label values so the exposition stays parseable', () => {
    const metrics = new MetricsCollector()
    metrics.observe('GET', '/a"b\\c', 200, 1)

    const text = metrics.render({ version: '1.0.0' })
    expect(text).toContain('route="/a\\"b\\\\c"')
  })

  it('omits database gauges without a file', () => {
    const metrics = new MetricsCollector()
    const text = metrics.render({ version: '1.0.0' })
    expect(text).not.toContain('mungil_db_size_bytes')
    expect(text).toContain('mungil_process_uptime_seconds')
    expect(text).toContain('mungil_process_resident_memory_bytes')
  })
})
