"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-renders the server page on a timer: fast while an agent is running, slow otherwise. */
export function AutoRefresh({ live }: { live: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, live ? 3000 : 30000);
    return () => clearInterval(id);
  }, [live, router]);
  return null;
}
