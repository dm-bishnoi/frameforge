/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@frameforge/project-schema",
    "@frameforge/timeline-engine",
    "@frameforge/media-engine",
    "@frameforge/render-engine",
    "@frameforge/ai-adapters",
    "@frameforge/mcp-dev-server",
    "@frameforge/mcp-video-server"
  ]
};

export default nextConfig;
