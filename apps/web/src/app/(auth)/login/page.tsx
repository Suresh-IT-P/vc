'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { loginSchema } from '@sonder/shared';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';
import { useAuthStore } from '@/store/auth';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  const login = useAuthStore((state) => state.login);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [identifier, setIdentifier] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    // Validate with the same schema the server uses, so the two cannot drift.
    const parsed = loginSchema.safeParse({ identifier, password });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      await login(parsed.data.identifier, parsed.data.password);
      const next = searchParams.get('next');
      router.replace(next && next.startsWith('/') ? next : '/');
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors);
        setFormError(error.fields.length === 0 ? error.message : null);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center lg:text-left">
        <h1 className="font-display text-2xl font-bold">Welcome back</h1>
        <p className="text-sm text-muted-foreground">
          Sign in to pick up your conversations.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field
          label="Email or username"
          htmlFor="identifier"
          error={errors.identifier}
        >
          <Input
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="you@example.com"
            invalid={Boolean(errors.identifier)}
            disabled={submitting}
          />
        </Field>

        <Field label="Password" htmlFor="password" error={errors.password}>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              className="pr-11"
              invalid={Boolean(errors.password)}
              disabled={submitting}
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <EyeOff className="size-4" aria-hidden />
              ) : (
                <Eye className="size-4" aria-hidden />
              )}
            </button>
          </div>
        </Field>

        {formError ? (
          <p role="alert" className="rounded-xl bg-destructive/10 px-3.5 py-2.5 text-sm font-medium text-destructive">
            {formError}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="brand"
          size="lg"
          className="w-full"
          loading={submitting}
        >
          Log in
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link href="/register" className="font-semibold text-primary hover:underline">
          Sign up
        </Link>
      </p>

      {/* Seeded accounts exist so the app can be tried immediately; they are
          clearly labelled rather than passed off as real users. */}
      <div className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground">Trying the demo?</p>
        <p className="mt-1 leading-relaxed">
          Seeded accounts <code className="font-mono">aria.reed</code>,{' '}
          <code className="font-mono">milo.kade</code> and ten others all use the
          password <code className="font-mono">Password123</code>. Sign in as two of
          them in separate browsers to test messaging and calls.
        </p>
      </div>
    </div>
  );
}
