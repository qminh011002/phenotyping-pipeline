// LoginPage — wired to /auth/login (FE-029).

import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { login } from '@/services/auth';
import { ApiError } from '@/services/errors';

const LINK_CLASS =
    'rounded-sm font-medium text-primary underline-offset-4 hover:underline focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function LoginPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [remember, setRemember] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    const canSubmit = email.trim().length > 0 && password.length > 0;

    async function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            await login(email.trim(), password);
            toast.success('Signed in');
            navigate(from, { replace: true });
        } catch (err) {
            const description =
                err instanceof ApiError && err.code === 'invalid_credentials'
                    ? 'Email or password is incorrect.'
                    : err instanceof Error
                      ? err.message
                      : 'Something went wrong.';
            toast.error('Sign-in failed', { description });
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AuthShell
            title="Welcome back"
            description="Enter your credentials to access your phenotyping workspace."
            footer={
                <>
                    Don't have an account?{' '}
                    <Link to="/register" className={LINK_CLASS}>
                        Create one
                    </Link>
                </>
            }
        >
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
                            className={`${LINK_CLASS} text-xs`}
                            onClick={() =>
                                toast.info('Password reset is not wired yet', {
                                    description: 'Talk to your admin to reset your password.',
                                })
                            }
                        >
                            Forgot password?
                        </button>
                    </div>
                    <div className="relative">
                        <Input
                            id="password"
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="current-password"
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className="pr-10"
                        />
                        <PasswordToggle
                            shown={showPassword}
                            onToggle={() => setShowPassword((v) => !v)}
                        />
                    </div>
                </div>

                <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground select-none">
                    <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
                    Keep me signed in on this device
                </label>

                <Button type="submit" disabled={!canSubmit || submitting} className="w-full">
                    <LogIn className="size-4" aria-hidden />
                    {submitting ? 'Signing in…' : 'Sign in'}
                </Button>
            </form>
        </AuthShell>
    );
}

// ── Shared auth layout ──────────────────────────────────────────────────────

interface AuthShellProps {
    /** Card heading — what this screen is for. */
    title: string;
    description: string;
    /** Line under the card — the link to the other auth screen. */
    footer: ReactNode;
    children: ReactNode;
}

/** Centered brand lockup + card used by the sign-in and sign-up screens. */
function AuthShell({ title, description, footer, children }: AuthShellProps) {
    return (
        <div className="flex min-h-screen w-full items-center justify-center bg-background px-6 py-10">
            <div className="w-full max-w-sm">
                <BrandHeader />

                <main className="panel p-6">
                    <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    <div className="mt-6">{children}</div>
                </main>

                <p className="mt-4 text-center text-sm text-muted-foreground">{footer}</p>

                <FooterNote />
            </div>
        </div>
    );
}

function BrandHeader() {
    return (
        <div className="mb-6 flex flex-col items-center text-center">
            <img
                src="/assets/logo/app-icon.png"
                alt=""
                aria-hidden
                className="size-14 rounded-lg object-cover"
            />
            <p className="mt-3 text-xl font-semibold tracking-tight">Phenotyping</p>
            <p className="mt-1 text-sm text-muted-foreground">
                Count and measure insect life stages from images.
            </p>
        </div>
    );
}

function FooterNote() {
    return (
        <p className="mt-8 text-center text-xs text-muted-foreground">
            Single-tenant desktop build · v0.1.0
        </p>
    );
}

interface PasswordToggleProps {
    shown: boolean;
    onToggle: () => void;
}

/** Eye button that sits inside the right edge of a password input. */
function PasswordToggle({ shown, onToggle }: PasswordToggleProps) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-label={shown ? 'Hide password' : 'Show password'}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
            {shown ? (
                <EyeOff className="size-4" aria-hidden />
            ) : (
                <Eye className="size-4" aria-hidden />
            )}
        </button>
    );
}

// Re-exported so RegisterPage can use the same layout without duplication.
export { AuthShell, BrandHeader, FooterNote, PasswordToggle, LINK_CLASS };
