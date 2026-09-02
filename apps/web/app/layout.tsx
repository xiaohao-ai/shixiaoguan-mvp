import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "@/components/providers";
import { GlobalGuardrail } from "@/components/global-guardrail";

export const metadata: Metadata = {
  title: {
    default: "试销官｜新品快反决策 Agent",
    template: "%s｜试销官",
  },
  description: "面向永嘉中小鞋企的可审计新品试销决策与实验编排工作台。",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <GlobalGuardrail />
          {children}
        </Providers>
      </body>
    </html>
  );
}
