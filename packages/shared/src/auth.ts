import { z } from "zod";

/**
 * Auth input schemas. Used by both the web frontend (for client-side
 * validation feedback) and server actions (which re-validate on the server —
 * never trust client-side validation alone).
 *
 * Password rule for week 1: minimum 8 characters. We deliberately do not
 * impose complexity rules; long pass phrases are stronger than short
 * complex passwords. Tighten before public launch if needed.
 */
export const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const signupSchema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
