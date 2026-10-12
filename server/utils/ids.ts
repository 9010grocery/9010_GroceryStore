import { z } from 'zod'

/**
 * The UI names rows with a letter and the database id (p12 = product 12, t5 = transaction 5, u3 = user 3).
 * Accepts "p12" or a plain 12 and gives back 12.
 */
export const prefixedId = (prefix: string) =>
  z.union([z.number(), z.string()]).transform((value, ctx) => {
    const n = Number(String(value).replace(new RegExp(`^${prefix}`), ''))
    if (!Number.isInteger(n) || n <= 0) {
      ctx.addIssue({ code: 'custom', message: 'Invalid id' })
      return z.NEVER
    }
    return n
  })
