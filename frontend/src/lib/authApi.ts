// Public (unauthenticated) calls to the backend auth endpoints.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

async function post(path: string, body: unknown): Promise<{ message?: string }> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Cannot reach the server. Please try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) throw new Error("Too many attempts. Please wait a while and try again.");
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}

export const registerAccount = (email: string, password: string, name: string) =>
  post("register", { email, password, name });
export const verifyEmailToken = (token: string) => post("verify-email", { token });
export const resendVerification = (email: string) => post("resend-verification", { email });
export const requestPasswordReset = (email: string) => post("forgot-password", { email });
export const resetPassword = (token: string, password: string) => post("reset-password", { token, password });
