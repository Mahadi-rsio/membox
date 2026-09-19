import { useEffect, useState } from "react";

const GATEWAY_API_KEY = "1234";

const FALLBACK_MODELS = [
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash" },
  { id: "glm-4.7", name: "GLM 4.7" },
  { id: "glm-4.6", name: "GLM 4.6" },
];

export type ModelOption = {
  id: string;
  name: string;
};

function formatModelName(id: string): string {
  const clean = id.replace(/^(progga\/|openai\/|deepseek\/|zhipu\/)/, "");
  return clean
    .split(/[\/:_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function useModels(): { models: ModelOption[]; loading: boolean; error: string | null } {
  const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/v1/models", {
          headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
        });
        if (!res.ok) {
          throw new Error(`Failed to load models (${res.status})`);
        }
        const json = await res.json();
        const data: { id: string }[] = Array.isArray(json?.data) ? json.data : [];
        const list = data
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
          .map((id) => ({ id, name: formatModelName(id) }));

        if (list.length === 0) {
          throw new Error("Model list is empty");
        }

        if (!cancelled) {
          setModels(list);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load models");
          setModels(FALLBACK_MODELS);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { models, loading, error };
}
