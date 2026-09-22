import { LegacyCrm } from "@/components/LegacyCrm";

export default function HomePage() {
  return <LegacyCrm assetVersion={process.env.VERCEL_GIT_COMMIT_SHA || "local"} />;
}
