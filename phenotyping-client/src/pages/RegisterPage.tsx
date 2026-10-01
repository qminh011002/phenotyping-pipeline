// RegisterPage — wired to /auth/register (FE-029).

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { register } from '@/services/auth';
import { ApiError } from '@/services/errors';
import { AuthShell, LINK_CLASS, PasswordToggle } from './LoginPage';

export default function RegisterPage() {
    const navigate = useNavigate();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [acceptedTerms, setAcceptedTerms] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const passwordOk = password.length >= 8;
    const passwordsMatch = password === confirm && confirm.length > 0;
    const canSubmit =
        name.trim().length > 0 &&
        email.trim().length > 0 &&
        passwordOk &&
        passwordsMatch &&
        acceptedTerms;

    const passwordInvalid = password.length > 0 && !passwordOk;
    const confirmInvalid = confirm.length > 0 && !passwordsMatch;

    async function handleSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            await register(email.trim(), password, name.trim() || null);
            toast.success('Account created');
            navigate('/', { replace: true });
        } catch (err) {
            const description =
                err instanceof ApiError && err.code === 'email_taken'
                    ? 'That email is already registered.'
                    : err instanceof Error
                      ? err.message
                      : 'Something went wrong.';
            toast.error('Sign-up failed', { description });
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AuthShell
            title="Create your account"
            description="Set up an account to track your analysis batches and saved models."
            footer={
                <>
                    Already have an account?{' '}
                    <Link to="/login" className={LINK_CLASS}>
                        Sign in
                    </Link>
                </>
            }
        >
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
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="new-password"
                            placeholder="At least 8 characters"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            aria-invalid={passwordInvalid}
                            aria-describedby={passwordInvalid ? 'password-error' : undefined}
                            className="pr-10"
                        />
                        <PasswordToggle
                            shown={showPassword}
                            onToggle={() => setShowPassword((v) => !v)}
                        />
                    </div>
                    {passwordInvalid && (
                        <p id="password-error" className="text-xs text-destructive">
                            Password must be at least 8 characters.
                        </p>
                    )}
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="confirm">Confirm password</Label>
                    <Input
                        id="confirm"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder="Re-enter your password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        required
                        aria-invalid={confirmInvalid}
                        aria-describedby={confirmInvalid ? 'confirm-error' : undefined}
                    />
                    {confirmInvalid && (
                        <p id="confirm-error" className="text-xs text-destructive">
                            Passwords don't match.
                        </p>
                    )}
                </div>

                <label className="flex cursor-pointer items-start gap-2 text-sm text-muted-foreground select-none">
                    <Checkbox
                        checked={acceptedTerms}
                        onCheckedChange={(v) => setAcceptedTerms(v === true)}
                        className="mt-0.5"
                    />
                    <span>
                        I agree to the{' '}
                        <a href="#" className={LINK_CLASS} onClick={(e) => e.preventDefault()}>
                            terms of service
                        </a>{' '}
                        and{' '}
                        <a href="#" className={LINK_CLASS} onClick={(e) => e.preventDefault()}>
                            privacy policy
                        </a>
                        .
                    </span>
                </label>

                <Button type="submit" disabled={!canSubmit || submitting} className="w-full">
                    <UserPlus className="size-4" aria-hidden />
                    {submitting ? 'Creating account…' : 'Create account'}
                </Button>
            </form>
        </AuthShell>
    );
}
