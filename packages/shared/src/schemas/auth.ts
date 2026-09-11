import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(24, 'Username must be at most 24 characters')
  .regex(
    /^[a-z0-9._]+$/,
    'Use lowercase letters, numbers, dots and underscores only',
  )
  .refine((v) => !v.startsWith('.') && !v.endsWith('.'), {
    message: 'Username cannot start or end with a dot',
  })
  .refine((v) => !v.includes('..'), {
    message: 'Username cannot contain consecutive dots',
  });

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), {
    message: 'Password must contain at least one letter and one number',
  });

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  username: usernameSchema,
  displayName: z.string().trim().min(1, 'Name is required').max(50),
  password: passwordSchema,
});

export const loginSchema = z.object({
  /** Accepts either an email address or a username. */
  identifier: z.string().trim().min(1, 'Enter your email or username'),
  password: z.string().min(1, 'Enter your password'),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  bio: z.string().trim().max(180).optional(),
  avatarUrl: z.string().trim().url().max(500).nullable().optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
