export const documentPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export const apiPolicy = "default-src 'none'; frame-ancestors 'none'"

export const withSecurityHeaders = (response: Response, policy: string): Response => {
  if (response.status === 101) return response
  const headers = new Headers(response.headers)
  headers.set('content-security-policy', policy)
  headers.set('x-frame-options', 'DENY')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  headers.set('strict-transport-security', 'max-age=31536000')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
