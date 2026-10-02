import NextAuth, { CredentialsSignin } from "next-auth"
import Credentials from "next-auth/providers/credentials"

// Email + password only. The Express backend is the authentication authority:
// it verifies the password and the email address and issues the session token.
// There is no offline/demo fallback: if the backend cannot be reached, sign-in fails.
const API_URL = process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"

class EmailNotVerified extends CredentialsSignin {
  code = "email_not_verified"
}
class RateLimited extends CredentialsSignin {
  code = "rate_limited"
}
class ServiceUnavailable extends CredentialsSignin {
  code = "service_unavailable"
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  pages: {
    signIn: "/auth/signin",
  },
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email : ""
        const password = typeof credentials?.password === "string" ? credentials.password : ""
        if (!email || !password) return null

        let res: Response
        try {
          res = await fetch(`${API_URL}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
          })
        } catch {
          throw new ServiceUnavailable()
        }

        const data = await res.json().catch(() => ({}))
        if (res.ok && data.user && data.token) {
          return {
            id: data.user.id,
            name: data.user.name,
            email: data.user.email,
            accessToken: data.token,
            accessTokenExpires: Date.parse(data.expiresAt) || undefined,
          } as any
        }
        if (res.status === 403 && data.code === "EMAIL_NOT_VERIFIED") throw new EmailNotVerified()
        if (res.status === 429) throw new RateLimited()
        if (res.status >= 500) throw new ServiceUnavailable()
        return null
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id || token.sub
        token.accessToken = (user as any).accessToken
        token.accessTokenExpires = (user as any).accessTokenExpires
      }
      return token
    },
    async session({ session, token }) {
      const expired =
        typeof token.accessTokenExpires === "number" && token.accessTokenExpires < Date.now()
      if (session.user) {
        ;(session.user as any).id = token.id
      }
      if (token.accessToken && !expired) {
        ;(session as any).accessToken = token.accessToken
      } else {
        ;(session as any).error = "SessionExpired"
      }
      return session
    },
  },
  events: {
    // Revoke the server-side session when the user signs out.
    async signOut(message) {
      const accessToken = "token" in message ? (message.token as any)?.accessToken : undefined
      if (!accessToken) return
      try {
        await fetch(`${API_URL}/api/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        })
      } catch {
        // Best effort: the session still expires on its own.
      }
    },
  },
})
