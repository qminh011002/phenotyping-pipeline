// LoginPage — visual scaffold only. Not wired to any auth backend yet;
// `handleSubmit` just toasts and navigates home so the flow feels complete.

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/sonner";

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    // Visual scaffold only — no real auth flow yet.
    window.setTimeout(() => {
      setSubmitting(false);
      toast.success("Signed in (mock)", {
        description: "Auth is not wired yet — this is the visual scaffold.",
      });
      navigate("/");
    }, 600);
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-background via-muted/40 to-primary/10 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <BrandHeader subtitle="Sign in to continue" />

        <Card className="border-border/70 shadow-sm">
          <CardHeader className="space-y-1 pb-2">
            <h2 className="text-xl font-semibold tracking-tight">Welcome back</h2>
            <p className="text-sm text-muted-foreground">
              Enter your credentials to access your phenotyping workspace.
            </p>
          </CardHeader>

          <CardContent className="pt-2">
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@entobel.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() =>
                      toast.info("Password reset is not wired yet", {
                        description: "Talk to your admin to reset your password.",
                      })
                    }
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground select-none">
                <Checkbox
                  checked={remember}
                  onCheckedChange={(v) => setRemember(v === true)}
                />
                Keep me signed in on this device
              </label>

              <Button type="submit" disabled={!canSubmit || submitting} className="w-full gap-2">
                <LogIn className="h-4 w-4" />
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>

            <Separator className="my-6" />

            <p className="text-center text-sm text-muted-foreground">
              Don't have an account?{" "}
              <Link to="/register" className="font-medium text-primary hover:underline">
                Create one
              </Link>
            </p>
          </CardContent>
        </Card>

        <FooterNote />
      </div>
    </div>
  );
}

// ── Shared visual bits ──────────────────────────────────────────────────────

function BrandHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-6 flex flex-col items-center text-center">
      <img
        src="/assets/gif/worm_cute_antennae.gif"
        alt=""
        aria-hidden
        className="h-16 w-auto [image-rendering:pixelated]"
      />
      <h1 className="mt-2 text-4xl font-bold tracking-tight text-primary">phenotyping</h1>
      <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
        {subtitle}
      </p>
    </div>
  );
}

function FooterNote() {
  return (
    <p className="mt-6 text-center text-[11px] text-muted-foreground">
      Single-tenant desktop build · v0.1.0
    </p>
  );
}

// Re-exported so RegisterPage can use the same brand block without duplication.
export { BrandHeader, FooterNote };
