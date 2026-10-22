import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { db } from "./db";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
].join(" ");

const allowed = (process.env.ALLOWED_EMAIL ?? "").toLowerCase();

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" }, // JWT so middleware can check sign-in; Google tokens still live in the Account table
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: { params: { scope: GOOGLE_SCOPES, access_type: "offline", prompt: "consent" } },
      // Single-owner app gated by ALLOWED_EMAIL, so re-linking Google to the existing user is safe.
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  callbacks: {
    // Only the owner can sign in.
    async signIn({ user, account }) {
      if (!allowed || user.email?.toLowerCase() !== allowed) return false;
      // A failed first sign-in can leave a user row with no Google account attached, which blocks every later sign-in.
      // Remove such leftovers so this sign-in creates the user and links Google cleanly.
      if (account && !(await db.account.findUnique({ where: { provider_providerAccountId: { provider: account.provider, providerAccountId: account.providerAccountId } } }))) {
        await db.user.deleteMany({ where: { email: { equals: user.email!, mode: "insensitive" }, accounts: { none: {} } } });
      }
      // Keep the newest refresh token on every sign-in so background jobs keep working.
      if (account?.refresh_token) {
        await db.account.updateMany({
          where: { provider: "google", providerAccountId: account.providerAccountId },
          data: {
            refresh_token: account.refresh_token,
            access_token: account.access_token,
            expires_at: account.expires_at,
            scope: account.scope,
          },
        });
      }
      return true;
    },
  },
  pages: { signIn: "/signin" },
};

export async function requireUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/signin");
  return session.user;
}
