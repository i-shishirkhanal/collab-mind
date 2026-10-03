import "next-auth"
import "next-auth/jwt"

declare module "next-auth" {
  interface User {
    accessToken?: string
    accessTokenExpires?: number
  }
  interface Session {
    accessToken?: string
    error?: string
    user: { id?: string } & import("next-auth").DefaultSession["user"]
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string
    accessToken?: string
    accessTokenExpires?: number
  }
}
