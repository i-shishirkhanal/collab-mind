"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

interface LogoutButtonProps {
  className?: string;
  variant?: "ghost" | "outline" | "default" | "destructive";
  size?: "default" | "sm" | "lg" | "icon";
  showText?: boolean;
}

export function LogoutButton({
  className,
  variant = "ghost",
  size = "default",
  showText = true,
}: LogoutButtonProps) {
  const handleLogout = async () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("supabase_auth_token");
    }
    await signOut({ callbackUrl: "/auth/signin" });
  };

  return (
    <Button
      onClick={handleLogout}
      variant={variant}
      size={size}
      className={
        className ||
        "text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors gap-2"
      }
      title="Log out of CollabMind"
    >
      <LogOut className="w-4 h-4" />
      {showText && <span>Log Out</span>}
    </Button>
  );
}
