import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getOptionalUser } from "@/lib/auth";

/**
 * Header widget that swaps based on session state. Server component — runs
 * on every request and cannot be cached across users. Drop this into any
 * public page's header to render a "Sign in" button for guests and an
 * email + Sign-out form for members.
 */
export async function AuthStatus() {
  const user = await getOptionalUser();

  if (!user) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href="/login">Sign in</Link>
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="num text-sm text-muted-foreground">{user.email}</span>
      <form action="/auth/sign-out" method="post">
        <Button type="submit" variant="outline" size="sm">
          Sign out
        </Button>
      </form>
    </div>
  );
}
