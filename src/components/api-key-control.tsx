import React, { useState } from "react";
import { useApiKey } from "@/components/api-key-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/lib/i18n";
import { toast } from "sonner";
import { RiKey2Line } from "@remixicon/react";

export function ApiKeyControl() {
  const { apiKey, ready, saveApiKey, clearApiKey } = useApiKey();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      saveApiKey(value);
      setValue("");
      setOpen(false);
      toast.success(t("auth.saved"));
    } catch {
      setError(t("auth.storage_error"));
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={!ready}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        title="API key"
        aria-label="API key"
        onClick={() => {
          setValue(apiKey);
          setError("");
          setOpen(true);
        }}
      >
        <RiKey2Line className="h-4 w-4" />
        <span className="hidden sm:inline">API key</span>
      </button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setValue("");
        }}
      >
        <DialogContent className="w-[calc(100%-2rem)] max-w-sm rounded-lg">
          <DialogHeader>
            <DialogTitle>API key</DialogTitle>
            <DialogDescription>{t("auth.description")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="api-key">API key</Label>
              <Input
                id="api-key"
                name="api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                required
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-500">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" className="flex-1" disabled={!value.trim()}>
                {t("save")}
              </Button>
              {apiKey && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    try {
                      clearApiKey();
                      setValue("");
                      setOpen(false);
                      toast.success(t("auth.cleared"));
                    } catch {
                      setError(t("auth.storage_error"));
                    }
                  }}
                >
                  {t("auth.clear")}
                </Button>
              )}
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
