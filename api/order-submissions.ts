import { handleOrderSubmissionsRequest, vercelClientIp } from '../server/order-submissions-http'

/**
 * Vercel adapter. Routing, auth, and cache headers live in server/,
 * shared with the Netlify function so both hosts stay identical.
 *
 * Uses the Web-standard Request/Response signature so no @vercel/node dependency
 * is needed. vercel.json rewrites /.netlify/functions/order-submissions to this route,
 * which lets the frontend keep calling one path on either host.
 */
export default async function handler(request: Request): Promise<Response> {
  return handleOrderSubmissionsRequest(request, vercelClientIp(request.headers))
}
