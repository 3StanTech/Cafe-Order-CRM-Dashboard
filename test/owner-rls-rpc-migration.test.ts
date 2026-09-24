import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationPath = resolve(process.cwd(), 'supabase/migrations/20260828010000_owner_rls_and_aggregate_rpcs.sql')
const schemaPath = resolve(process.cwd(), 'supabase/schema.sql')
const checkPath = resolve(process.cwd(), 'supabase/checks/02_schema.sql')
const migration = readFileSync(migrationPath, 'utf8')
const schema = readFileSync(schemaPath, 'utf8')
const checks = readFileSync(checkPath, 'utf8')

describe('owner RLS and aggregate RPC migration', () => {
  it('runs in a single transaction and is marked hand-apply only', () => {
    expect(migration).toMatch(/never by CI/)
    expect(migration).toMatch(/(^|\n)begin;\n/)
    expect(migration.trimEnd()).toMatch(/commit;$/)
  })

  it('binds policies to dashboard_owner_uid rather than any authenticated role', () => {
    expect(migration).toContain("email = 'angela@madebyangela.local'")
    expect(schema).toContain("email = 'acosta.angelatherese@gmail.com'")
    expect(migration).toContain('auth.uid() = public.dashboard_owner_uid()')
    expect(migration).toContain('raise exception \'A public table policy still uses using (true)\'')
    expect(schema).toContain('auth.uid() = public.dashboard_owner_uid()')
    expect(schema).not.toMatch(/for select to authenticated using \(true\)/)
  })

  it('creates the three aggregate RPCs as security invoker', () => {
    for (const name of ['create_order_with_items', 'replace_order_items', 'delete_customer_cascade']) {
      expect(migration).toContain(`create or replace function public.${name}`)
      expect(schema).toContain(`create or replace function public.${name}`)
    }
    expect(migration).toContain('security invoker')
  })

  it('fails closed if the owner email is missing from auth.users', () => {
    expect(migration).toContain('dashboard_owner_uid() is null')
  })

  it('does not mutate business row data', () => {
    expect(migration.toLowerCase()).not.toMatch(/\btruncate\b/)
    expect(migration.toLowerCase()).not.toMatch(/\bdrop\s+table\b/)
    expect(migration).not.toMatch(/delete from public\.orders;/)
    expect(migration).not.toMatch(/delete from public\.customers;/)
  })

  it('extends the post-migration schema check', () => {
    expect(checks).toContain('owner_uid_present')
    expect(checks).toContain('owner_rpc_function_count')
    expect(checks).toContain('open_authenticated_policies')
  })
})
