import { LoginForm } from "./form";

export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await searchParams;
  const notice = p.denied ? "That account doesn't have staff access." : p.expired ? "Your session ended. Sign in again." : null;
  return <LoginForm notice={notice} />;
}
