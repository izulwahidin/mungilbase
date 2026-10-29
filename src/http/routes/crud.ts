import type { Hono } from 'hono'
import type { AppEnv } from '../app.js'
import type { Db } from '../../db/connect.js'
import type { Registry, RegisteredTable } from '../../tables/registry.js'
import { createRow, deleteRow, listRows, updateRow, viewRow } from '../../tables/crud.js'
import { readJson } from '../body.js'
import { notFound } from '../errors.js'

export interface CrudRoutesDeps {
  db: Db
  registry: Registry
}

export function registerCrudRoutes(app: Hono<AppEnv>, deps: CrudRoutesDeps): void {
  app.get('/api/v1/:table', (c) => {
    const table = tableOrThrow(deps.registry, c.req.param('table'))
    return c.json(
      listRows(deps.db, table, c.get('auth'), {
        filter: c.req.query('filter'),
        sort: c.req.query('sort'),
        limit: optionalNumber(c.req.query('limit')),
        offset: optionalNumber(c.req.query('offset')),
      }),
    )
  })

  app.get('/api/v1/:table/:id', (c) => {
    const table = tableOrThrow(deps.registry, c.req.param('table'))
    return c.json(viewRow(deps.db, table, c.get('auth'), c.req.param('id')))
  })

  app.post('/api/v1/:table', async (c) => {
    const table = tableOrThrow(deps.registry, c.req.param('table'))
    const body = await readJson(c)
    return c.json(createRow(deps.db, table, c.get('auth'), body), 201)
  })

  app.patch('/api/v1/:table/:id', async (c) => {
    const table = tableOrThrow(deps.registry, c.req.param('table'))
    const body = await readJson(c)
    return c.json(updateRow(deps.db, table, c.get('auth'), c.req.param('id'), body))
  })

  app.delete('/api/v1/:table/:id', (c) => {
    const table = tableOrThrow(deps.registry, c.req.param('table'))
    return c.json(deleteRow(deps.db, table, c.get('auth'), c.req.param('id')))
  })
}

function tableOrThrow(registry: Registry, name: string): RegisteredTable {
  const table = registry.get(name)
  if (!table) throw notFound(`Unknown table "${name}"`)
  return table
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  return Number(value)
}
