import { z } from 'zod'

export const employeeStatusEnum = z.enum(['ACTIVE', 'INACTIVE'])

export const employeeCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  email: z
    .union([z.literal(''), z.email('Enter a valid email')])
    .optional()
    .transform((v) => (v ? v : undefined)),
  status: employeeStatusEnum.default('ACTIVE'),
})

export const employeeUpdateSchema = employeeCreateSchema.extend({
  id: z.uuid(),
})

export const employeeStatusSchema = z.object({
  id: z.uuid(),
  status: employeeStatusEnum,
})

export const assignEmployeeSchema = z.object({
  client_id: z.uuid(),
  employee_id: z.uuid(),
})

export const unassignEmployeeSchema = z.object({
  client_employee_id: z.uuid(),
})

export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>
export type AssignEmployeeInput = z.infer<typeof assignEmployeeSchema>
