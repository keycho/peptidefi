import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

/**
 * Protected home placeholder for Phase A. Charts arrive in the next sub-step.
 * Middleware already redirects unauthenticated visitors to /login, but we
 * re-check here defensively.
 */
export default async function HomePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

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
          <form action="/auth/sign-out" method="post">
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>

      <section className="container py-10">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="text-base">You&rsquo;re in.</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Logged in as{" "}
              <span className="num text-foreground">{user.email}</span>.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Charts will land in the next sub-step.
            </p>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
