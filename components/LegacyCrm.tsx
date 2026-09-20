"use client";

import Script from "next/script";
import { useEffect, useState } from "react";
import { legacyConfig } from "./legacy-config";
import { legacyMarkup } from "./legacy-markup";

export function LegacyCrm() {
  const [configReady, setConfigReady] = useState(false);

  useEffect(() => {
    window.CRM_CONFIG = legacyConfig;
    setConfigReady(true);
  }, []);

  return (
    <>
      <div id="legacy-root" dangerouslySetInnerHTML={{ __html: legacyMarkup }} />
      {configReady ? <Script src="/legacy/app.js" strategy="afterInteractive" /> : null}
    </>
  );
}

declare global {
  interface Window {
    CRM_CONFIG: typeof legacyConfig;
  }
}
