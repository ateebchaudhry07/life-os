/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["googleapis", "node-ical", "@prisma/client"],
    serverActions: { bodySizeLimit: "4mb" }, // statement PDFs; Vercel caps request bodies at 4.5 MB
  },
};
export default nextConfig;
