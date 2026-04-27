import { AuthStatus } from "@/components/auth-status";

/**
 * Public home placeholder. Anyone can land here without a session — login
 * is gated only on private routes (/portfolio, /account) and on action
 * APIs that mutate user state. The header's <AuthStatus /> swaps between
 * a "Sign in" button (guest) and email + sign-out form (member).
 *
 * Charts replace this placeholder in the next sub-step.
 */
export default async function HomePage() {
  return (
    <main className="terminal-grid min-h-screen">
      <header className="border-b border-border">
        <div className="container flex items-center justify-between py-4">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold tracking-tight">
              PeptideFi
            </span>
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              Season 1
            </span>
          </div>
          <AuthStatus />
        </div>
      </header>

      <section className="container py-10">
        <p className="text-sm text-muted-foreground">
          PeptideFi — public home. Charts coming next sub-step.
        </p>
      </section>
    </main>
  );
}
