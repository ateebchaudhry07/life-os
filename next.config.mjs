/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverComponentsExternalPackages: ["googleapis", "node-ical", "@prisma/client"] },
};
export default nextConfig;
