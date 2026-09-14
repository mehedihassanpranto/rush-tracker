import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  assignEmployeeSchema,
  employeeCreateSchema,
  employeeStatusSchema,
  employeeUpdateSchema,
  unassignEmployeeSchema,
} from '@/schemas/employee'
import type {
  ClientEmployeeRow,
  Employee,
  EmployeeWithClients,
} from '@/types/domain'

export const listEmployeesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<EmployeeWithClients>> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: employees, error } = await admin
      .from('employees')
      .select('*')
      .eq('organization_id', actor.organizationId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)

    const { data: links } = await admin
      .from('client_employees')
      .select('employee_id, client:clients(id, client_code, name)')
      .eq('organization_id', actor.organizationId)

    const clientsByEmployee = new Map<
      string,
      Array<{ id: string; client_code: string; name: string }>
    >()
    for (const row of (links ?? []) as unknown as Array<{
      employee_id: string
      client: { id: string; client_code: string; name: string } | null
    }>) {
      if (!row.client) continue
      const list = clientsByEmployee.get(row.employee_id) ?? []
      list.push(row.client)
      clientsByEmployee.set(row.employee_id, list)
    }

    return (employees as Array<Employee>).map((e) => ({
      ...e,
      clients: clientsByEmployee.get(e.id) ?? [],
    }))
  },
)

export const getEmployeeFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<EmployeeWithClients> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: employee, error } = await admin
      .from('employees')
      .select('*')
      .eq('id', data.id)
      .eq('organization_id', actor.organizationId)
      .single()
    if (error) throw new Error(error.message)

    const { data: links } = await admin
      .from('client_employees')
      .select('client:clients(id, client_code, name)')
      .eq('employee_id', data.id)
      .eq('organization_id', actor.organizationId)

    const clients = ((links ?? []) as unknown as Array<{
      client: { id: string; client_code: string; name: string } | null
    }>)
      .map((r) => r.client)
      .filter((c): c is { id: string; client_code: string; name: string } => c !== null)

    return { ...(employee as Employee), clients }
  })

/** Employees assigned to one client (for the client detail page's tab). */
export const listClientEmployeesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid() }))
  .handler(async ({ data }): Promise<Array<ClientEmployeeRow>> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: rows, error } = await admin
      .from('client_employees')
      .select('id, assigned_at, employee:employees(id, employee_code, name, status)')
      .eq('client_id', data.client_id)
      .eq('organization_id', actor.organizationId)
      .order('assigned_at', { ascending: false })
    if (error) throw new Error(error.message)

    return (rows ?? []) as unknown as Array<ClientEmployeeRow>
  })

/** Employees not yet assigned to a given client — dropdown source for the
 * assign dialog. */
export const listAssignableEmployeesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid() }))
  .handler(async ({ data }): Promise<Array<Employee>> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: employees, error } = await admin
      .from('employees')
      .select('*')
      .eq('status', 'ACTIVE')
      .eq('organization_id', actor.organizationId)
      .order('name')
    if (error) throw new Error(error.message)

    const { data: existing } = await admin
      .from('client_employees')
      .select('employee_id')
      .eq('client_id', data.client_id)
      .eq('organization_id', actor.organizationId)
    const already = new Set(
      (existing ?? []).map((r) => r.employee_id as string),
    )

    return (employees as Array<Employee>).filter((e) => !already.has(e.id))
  })

export const createEmployeeFn = createServerFn({ method: 'POST' })
  .validator(employeeCreateSchema)
  .handler(async ({ data }): Promise<Employee> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: employee, error } = await admin
      .from('employees')
      .insert({
        name: data.name,
        email: data.email ?? null,
        status: data.status,
        organization_id: actor.organizationId,
      })
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'EMPLOYEE_CREATED',
      entityType: 'EMPLOYEE',
      entityId: employee.id,
      newValues: employee,
    })
    return employee as Employee
  })

export const updateEmployeeFn = createServerFn({ method: 'POST' })
  .validator(employeeUpdateSchema)
  .handler(async ({ data }): Promise<Employee> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: before } = await admin
      .from('employees')
      .select('*')
      .eq('id', data.id)
      .eq('organization_id', actor.organizationId)
      .single()
    if (!before) throw new Error('Employee not found')

    const { data: employee, error } = await admin
      .from('employees')
      .update({ name: data.name, email: data.email ?? null, status: data.status })
      .eq('id', data.id)
      .eq('organization_id', actor.organizationId)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'EMPLOYEE_UPDATED',
      entityType: 'EMPLOYEE',
      entityId: data.id,
      oldValues: before ?? null,
      newValues: employee,
    })
    return employee as Employee
  })

export const setEmployeeStatusFn = createServerFn({ method: 'POST' })
  .validator(employeeStatusSchema)
  .handler(async ({ data }): Promise<Employee> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: employee, error } = await admin
      .from('employees')
      .update({ status: data.status })
      .eq('id', data.id)
      .eq('organization_id', actor.organizationId)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'EMPLOYEE_STATUS_CHANGED',
      entityType: 'EMPLOYEE',
      entityId: data.id,
      newValues: { status: data.status },
    })
    return employee as Employee
  })

export const assignEmployeeToClientFn = createServerFn({ method: 'POST' })
  .validator(assignEmployeeSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_MANAGE)
    const admin = getSupabaseAdminClient()

    // Never trust that client_id/employee_id belong to the caller's own org.
    const [{ data: client }, { data: employee }] = await Promise.all([
      admin
        .from('clients')
        .select('id')
        .eq('id', data.client_id)
        .eq('organization_id', actor.organizationId)
        .maybeSingle(),
      admin
        .from('employees')
        .select('id')
        .eq('id', data.employee_id)
        .eq('organization_id', actor.organizationId)
        .maybeSingle(),
    ])
    if (!client) throw new Error('Client not found')
    if (!employee) throw new Error('Employee not found')

    const { error } = await admin.from('client_employees').insert({
      client_id: data.client_id,
      employee_id: data.employee_id,
      organization_id: actor.organizationId,
    })
    if (error) {
      if (error.code === '23505') {
        throw new Error('This employee is already assigned to this client.')
      }
      throw new Error(error.message)
    }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'EMPLOYEE_ASSIGNED_TO_CLIENT',
      entityType: 'EMPLOYEE',
      entityId: data.employee_id,
      newValues: { client_id: data.client_id },
    })
    return { ok: true }
  })

export const unassignEmployeeFromClientFn = createServerFn({ method: 'POST' })
  .validator(unassignEmployeeSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: link } = await admin
      .from('client_employees')
      .select('client_id, employee_id')
      .eq('id', data.client_employee_id)
      .eq('organization_id', actor.organizationId)
      .single()
    if (!link) throw new Error('Assignment not found')

    const { error } = await admin
      .from('client_employees')
      .delete()
      .eq('id', data.client_employee_id)
      .eq('organization_id', actor.organizationId)
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'EMPLOYEE_UNASSIGNED_FROM_CLIENT',
      entityType: 'EMPLOYEE',
      entityId: link?.employee_id ?? null,
      oldValues: link ?? null,
    })
    return { ok: true }
  })

/**
 * Delete an employee — only when they have no current client assignments,
 * same precaution as deleteClientFn (spec pattern: block deletion when
 * anything still references the row, point the admin at unassigning first
 * rather than silently cascading). Unlike clients there's no financial
 * history to protect here (client_employees is a plain current-state
 * junction, not a ledger), but "unassign first" keeps the same predictable
 * behavior admins already expect from Delete elsewhere in this app.
 */
export const deleteEmployeeFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.EMPLOYEES_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: employee } = await admin
      .from('employees')
      .select('id, employee_code, name')
      .eq('id', data.id)
      .eq('organization_id', actor.organizationId)
      .single()
    if (!employee) throw new Error('Employee not found')

    const { count } = await admin
      .from('client_employees')
      .select('id', { count: 'exact', head: true })
      .eq('employee_id', data.id)
    if ((count ?? 0) > 0) {
      throw new Error(
        `This employee is assigned to ${count} client(s) and cannot be deleted. Unassign them first.`,
      )
    }

    const { error } = await admin
      .from('employees')
      .delete()
      .eq('id', data.id)
      .eq('organization_id', actor.organizationId)
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'EMPLOYEE_DELETED',
      entityType: 'EMPLOYEE',
      entityId: data.id,
      oldValues: employee,
    })
    return { ok: true }
  })
