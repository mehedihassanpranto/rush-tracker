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
    await requireAdmin(PERMISSIONS.EMPLOYEES_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: employees, error } = await admin
      .from('employees')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)

    const { data: links } = await admin
      .from('client_employees')
      .select('employee_id, client:clients(id, client_code, name)')

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
    await requireAdmin(PERMISSIONS.EMPLOYEES_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: employee, error } = await admin
      .from('employees')
      .select('*')
      .eq('id', data.id)
      .single()
    if (error) throw new Error(error.message)

    const { data: links } = await admin
      .from('client_employees')
      .select('client:clients(id, client_code, name)')
      .eq('employee_id', data.id)

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
    await requireAdmin(PERMISSIONS.EMPLOYEES_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: rows, error } = await admin
      .from('client_employees')
      .select('id, assigned_at, employee:employees(id, employee_code, name, status)')
      .eq('client_id', data.client_id)
      .order('assigned_at', { ascending: false })
    if (error) throw new Error(error.message)

    return (rows ?? []) as unknown as Array<ClientEmployeeRow>
  })

/** Employees not yet assigned to a given client — dropdown source for the
 * assign dialog. */
export const listAssignableEmployeesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid() }))
  .handler(async ({ data }): Promise<Array<Employee>> => {
    await requireAdmin(PERMISSIONS.EMPLOYEES_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: employees, error } = await admin
      .from('employees')
      .select('*')
      .eq('status', 'ACTIVE')
      .order('name')
    if (error) throw new Error(error.message)

    const { data: existing } = await admin
      .from('client_employees')
      .select('employee_id')
      .eq('client_id', data.client_id)
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
      .insert({ name: data.name, email: data.email ?? null, status: data.status })
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
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
      .single()

    const { data: employee, error } = await admin
      .from('employees')
      .update({ name: data.name, email: data.email ?? null, status: data.status })
      .eq('id', data.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
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
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
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

    const { error } = await admin
      .from('client_employees')
      .insert({ client_id: data.client_id, employee_id: data.employee_id })
    if (error) {
      if (error.code === '23505') {
        throw new Error('This employee is already assigned to this client.')
      }
      throw new Error(error.message)
    }

    await writeAudit({
      actorUserId: actor.id,
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
      .single()

    const { error } = await admin
      .from('client_employees')
      .delete()
      .eq('id', data.client_employee_id)
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      action: 'EMPLOYEE_UNASSIGNED_FROM_CLIENT',
      entityType: 'EMPLOYEE',
      entityId: link?.employee_id ?? null,
      oldValues: link ?? null,
    })
    return { ok: true }
  })
