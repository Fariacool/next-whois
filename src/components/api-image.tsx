import React, { useEffect, useState } from "react";
import { useApiKey } from "@/components/api-key-provider";
import { useTranslation } from "@/lib/i18n";

export function ApiImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const { apiKey, ready, request } = useApiKey();
  const { t } = useTranslation();
  const [image, setImage] = useState<{
    src: string;
    apiKey: string;
    url?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    async function load() {
      try {
        const response = await request(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`Error ${response.status}`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ src, apiKey, url: objectUrl });
      } catch (error) {
        if (!controller.signal.aborted) {
          setImage({
            src,
            apiKey,
            error: error instanceof Error ? error.message : "Image failed",
          });
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiKey, ready, request, src]);

  const current = image?.src === src && image.apiKey === apiKey ? image : null;
  if (!current?.url) {
    return (
      <p
        role={current?.error ? "alert" : "status"}
        className="p-6 text-center text-sm text-muted-foreground"
      >
        {current?.error || t("auth.loading")}
      </p>
    );
  }
  return <img src={current.url} alt={alt} className={className} />;
}
