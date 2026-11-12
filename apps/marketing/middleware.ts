import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, cookieOptions, parseSession, refreshSession } from "@/lib/admin-session";

/**
 * Staff console gate. Every /admin page except the sign-in needs a session cookie;
 * an access token close to expiry is refreshed here (server components can't set
 * cookies), and the new one is passed to this request as well as the browser.
 *
 * This is convenience, not the security boundary: the API checks staff_roles on
 * every /admin call, so a forged or stale cookie gets nothing but a 403.
 */
export const config = { matcher: ["/admin/:path*", "/admin"] };

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  res.headers.set("Cache-Control", "no-store");
  if (req.nextUrl.pathname === "/admin/login") return res;

  const s = parseSession(req.cookies.get(ADMIN_COOKIE)?.value);
  const toLogin = () => {
    const r = NextResponse.redirect(new URL("/admin/login", req.url));
    r.cookies.delete({ name: ADMIN_COOKIE, path: "/admin" });
    return r;
  };
  if (!s) return toLogin();
  if (s.exp - 120 > Date.now() / 1000) return res;

  const fresh = await refreshSession(s);
  if (!fresh) return toLogin();
  const value = JSON.stringify(fresh);
  req.cookies.set(ADMIN_COOKIE, value);
  const next = NextResponse.next({ request: req });
  next.headers.set("X-Robots-Tag", "noindex, nofollow");
  next.headers.set("Cache-Control", "no-store");
  next.cookies.set(ADMIN_COOKIE, value, cookieOptions(fresh.since));
  return next;
}
