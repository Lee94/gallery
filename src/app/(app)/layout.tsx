import Link from "next/link";
import { redirect } from "next/navigation";
import { logout } from "@/actions/auth";
import { getCurrentUser } from "@/lib/auth/current-user";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
          <nav className="flex items-center gap-6">
            <Link href="/dashboard" className="text-base font-semibold tracking-tight">
              Gallery
            </Link>
            {user.role === "admin" && (
              <Link
                href="/admin/invites"
                className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                邀请码
              </Link>
            )}
          </nav>
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-zinc-500 sm:inline">
              {user.email}
            </span>
            <form action={logout}>
              <button
                type="submit"
                className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                退出
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
