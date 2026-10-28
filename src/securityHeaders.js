// Browser security headers for the dashboard page. The Express server sends these
// through helmet; Netlify sends the same values from netlify.toml, and a unit test keeps
// the two copies identical.
//
// The page is one inline script with inline event handlers, so scripts need
// 'unsafe-inline' (everything user-typed is escaped before it reaches the page). What the
// policy adds on top: the page may only talk to its own server (connect-src) and load
// images from itself, so injected markup cannot ship data elsewhere through a request;
// no other site may frame it (clickjacking); and plugins, <base> and foreign form posts
// are off.
export const CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
  "img-src": ["'self'", "data:", "blob:"],
  "connect-src": ["'self'"],
  "worker-src": ["'self'", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"]
};

export const CONTENT_SECURITY_POLICY = Object.entries(CSP_DIRECTIVES)
  .map(([name, values]) => `${name} ${values.join(" ")}`)
  .join("; ");

export const REFERRER_POLICY = "strict-origin-when-cross-origin";
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
