'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { registerSchema } from '@sonder/shared';
import { Check, Eye, EyeOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';
import { useAuthStore } from '@/store/auth';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function RegisterPage() {
  const register = useAuthStore((state) => state.register);
  const router = useRouter();

  const [values, setValues] = React.useState({
    displayName: '',
    username: '',
    email: '',
    password: '',
  });
  const [showPassword, setShowPassword] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const set = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value =
      key === 'username' ? event.target.value.toLowerCase().replace(/\s+/g, '') : event.target.value;
    setValues((current) => ({ ...current, [key]: value }));
  };

  const rules = [
    { label: 'At least 8 characters', valid: values.password.length >= 8 },
    { label: 'Contains a letter', valid: /[a-zA-Z]/.test(values.password) },
    { label: 'Contains a number', valid: /[0-9]/.test(values.password) },
  ];

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    const parsed = registerSchema.safeParse(values);
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
      await register(parsed.data);
      router.replace('/');
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors);
        if (error.fields.length === 0) setFormError(error.message);
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
        <h1 className="font-display text-2xl font-bold">Create your account</h1>
        <p className="text-sm text-muted-foreground">
          It takes about thirty seconds.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field label="Name" htmlFor="displayName" error={errors.displayName}>
          <Input
            value={values.displayName}
            onChange={set('displayName')}
            autoComplete="name"
            placeholder="Alex Rivera"
            invalid={Boolean(errors.displayName)}
            disabled={submitting}
          />
        </Field>

        <Field
          label="Username"
          htmlFor="username"
          error={errors.username}
          hint="Lowercase letters, numbers, dots and underscores."
        >
          <Input
            value={values.username}
            onChange={set('username')}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="alex.rivera"
            invalid={Boolean(errors.username)}
            disabled={submitting}
          />
        </Field>

        <Field label="Email" htmlFor="email" error={errors.email}>
          <Input
            type="email"
            value={values.email}
            onChange={set('email')}
            autoComplete="email"
            autoCapitalize="none"
            placeholder="you@example.com"
            invalid={Boolean(errors.email)}
            disabled={submitting}
          />
        </Field>

        <Field label="Password" htmlFor="password" error={errors.password}>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={values.password}
              onChange={set('password')}
              autoComplete="new-password"
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

        {values.password.length > 0 ? (
          <ul className="space-y-1" aria-live="polite">
            {rules.map((rule) => (
              <li
                key={rule.label}
                className={cn(
                  'flex items-center gap-2 text-xs',
                  rule.valid ? 'text-signal-excellent' : 'text-muted-foreground',
                )}
              >
                {rule.valid ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <X className="size-3.5" aria-hidden />
                )}
                {rule.label}
              </li>
            ))}
          </ul>
        ) : null}

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
          Create account
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
