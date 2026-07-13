import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // drizzle-orm 也保持外置：standalone 输出里 migrate.mjs 需要以真实模块 import 它
  serverExternalPackages: ["better-sqlite3", "@node-rs/argon2", "drizzle-orm"],
  async headers() {
    return [
      {
        // /api/raw 提供用户上传的内容，需要被 iframe 嵌入且自带更严格的响应头，
        // 因此从全局安全头中排除
        source: "/((?!api/raw).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
