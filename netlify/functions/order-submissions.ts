import type { Context } from '@netlify/functions'
import { handleOrderSubmissionsRequest, netlifyClientIp } from '../../server/order-submissions-http'

/** Netlify adapter. Routing, auth, and cache headers live in server/. */
export default async function handler(request: Request, context: Context): Promise<Response> {
  return handleOrderSubmissionsRequest(request, netlifyClientIp(context))
}
