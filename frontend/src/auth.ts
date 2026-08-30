import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import Credentials from "next-auth/providers/credentials"

export const { handlers, auth, signIn, signOut } = NextAuth({
  pages: {
    signIn: '/auth/signin',
  },
  providers: [
    Google,
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        name: { label: "Name", type: "text" }
      },
      async authorize(credentials) {
        if (!credentials?.email) return null;
        const email = credentials.email as string;
        const inputName = credentials.name as string | undefined;
        const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
        try {
          const res = await fetch(`${API_URL}/api/auth/email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, name: inputName })
          });
          const data = await res.json();
          if (res.ok && data.user && data.token) {
            return { id: data.user.id, name: data.user.name, email: data.user.email, accessToken: data.token };
          }
        } catch (e) {
          // Backend is not running – fall back to a local demo user so the UI is still usable
          console.warn("Backend unreachable, creating local demo session for:", email);
          const demoId = `demo-${email.replace(/[^a-z0-9]/gi, '-')}`;
          const name = inputName || email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          return { id: demoId, name, email, accessToken: `demo-token-${demoId}` };
        }
        return null;
      }
    })
  ],
  callbacks: {
    async jwt({ token, user, account }) {
      if (user) {
        token.id = user.id || token.sub;
        if ((user as any).accessToken) {
          token.accessToken = (user as any).accessToken;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.id;
      }
      if (token.accessToken) {
        (session as any).accessToken = token.accessToken;
      }
      return session;
    },
  },
})
