import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HiveForge — Closed Loop Control Room",
  description: "Local-first orchestration for Codex runs, evidence and review contracts."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
