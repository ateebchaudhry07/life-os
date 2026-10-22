"use client";
import { signIn } from "next-auth/react";

export default function SignIn() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card" style={{ maxWidth: 420 }}>
        <h1>Life OS</h1>
        <p className="note">Sign in with your Google account. This connects Gmail (read-only) and Google Calendar so the app can track payments, bookings and your schedule.</p>
        <button className="primary" onClick={() => signIn("google", { callbackUrl: "/" })}>Continue with Google</button>
      </div>
    </main>
  );
}
