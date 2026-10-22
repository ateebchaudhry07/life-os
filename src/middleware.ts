export { default } from "next-auth/middleware";

// Everything needs sign-in except the sign-in page, NextAuth itself, and cron (which uses CRON_SECRET).
export const config = { matcher: ["/((?!api/auth|api/cron|signin|_next|favicon.ico).*)"] };
