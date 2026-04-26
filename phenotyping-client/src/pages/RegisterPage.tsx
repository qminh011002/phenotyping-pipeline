// RegisterPage — visual scaffold only. Mirrors LoginPage and reuses the same
// brand header/footer for visual consistency. Not wired to any auth backend.

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/sonner";
import { BrandHeader, FooterNote } from "./LoginPage";

export default function RegisterPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Lightweight UX checks — auth is not wired so these only gate the toast.
  const passwordOk = password.length >= 8;
  const passwordsMatch = password === confirm && confirm.length > 0;
  const canSubmit =
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    passwordOk &&
    passwordsMatch &&
    acceptedTerms;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    window.setTimeout(() => {
      setSubmitting(false);
      toast.success("Account created (mock)", {
        description: "Auth is not wired yet — this is the visual scaffold.",
      });
      navigate("/");
    }, 600);
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-background via-muted/40 to-primary/10 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <BrandHeader subtitle="Create your account" />

        <Card className="border-border/70 shadow-sm">
          <CardHeader className="space-y-1 pb-2">
            <h2 className="text-xl font-semibold tracking-tight">Get started</h2>
            <p className="text-sm text-muted-foreground">
              Set up an account to track your analysis batches and saved models.
            </p>
          </CardHeader>

          <CardContent className="pt-2">
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="name">Full name</Label>
                <Input
                  id="name"
                  autoComplete="name"
                  placeholder="Minh Tran"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

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
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    aria-invalid={password.length > 0 && !passwordOk}
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
                {password.length > 0 && !passwordOk && (
                  <p className="text-xs text-destructive">
                    Password must be at least 8 characters.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="Re-enter your password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  aria-invalid={confirm.length > 0 && !passwordsMatch}
                />
                {confirm.length > 0 && !passwordsMatch && (
                  <p className="text-xs text-destructive">Passwords don't match.</p>
                )}
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-sm text-muted-foreground select-none">
                <Checkbox
                  checked={acceptedTerms}
                  onCheckedChange={(v) => setAcceptedTerms(v === true)}
                  className="mt-0.5"
                />
                <span>
                  I agree to the{" "}
                  <a
                    href="#"
                    className="text-primary hover:underline"
                    onClick={(e) => e.preventDefault()}
                  >
                    terms of service
                  </a>{" "}
                  and{" "}
                  <a
                    href="#"
                    className="text-primary hover:underline"
                    onClick={(e) => e.preventDefault()}
                  >
                    privacy policy
                  </a>
                  .
                </span>
              </label>

              <Button type="submit" disabled={!canSubmit || submitting} className="w-full gap-2">
                <UserPlus className="h-4 w-4" />
                {submitting ? "Creating account…" : "Create account"}
              </Button>
            </form>

            <Separator className="my-6" />

            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link to="/login" className="font-medium text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </CardContent>
        </Card>

        <FooterNote />
      </div>
    </div>
  );
}
