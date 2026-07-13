import { cache } from "react";
import type { User } from "@/db/schema";
import { validateSession } from "./session";

// React cache()：同一次请求内 layout / page / action 多处调用只查一次库
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const result = await validateSession();
  return result?.user ?? null;
});
