import { NextResponse, type NextRequest } from "next/server";

export default function proxy(request: NextRequest) {
  const token = 
    request.cookies.get("authjs.session-token")?.value ||
    request.cookies.get("__Secure-authjs.session-token")?.value ||
    request.cookies.get("next-auth.session-token")?.value ||
    request.cookies.get("__Secure-next-auth.session-token")?.value;

  const isLoggedIn = !!token;
  const { pathname } = request.nextUrl;

  const isAuthPage = pathname.startsWith("/auth");

  if (!isLoggedIn && !isAuthPage) {
    return NextResponse.redirect(new URL("/auth/signin", request.url));
  }

  if (isLoggedIn && isAuthPage) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/workspace/:path*",
    "/auth/signin",
  ],
};
