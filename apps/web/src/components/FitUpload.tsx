import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatDistance } from "../lib/units";
import { InlineError } from "./States";
import { GarminAttribution } from "./WorkoutBits";
import { useUnits } from "../api/hooks";

/** Manual FIT upload (§3.4), for any watch. */
export function FitUpload({ compact = false }: { compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const units = useUnits();
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadFit(file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["activities"] });
      void qc.invalidateQueries({ queryKey: ["workouts"] });
    },
  });
  return (
    <div className="stack stack--tight">
      <input
        ref={input}
        type="file"
        accept=".fit,application/vnd.ant.fit,application/octet-stream"
        className="visually-hidden"
        aria-label="FIT file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = "";
        }}
      />
      <div>
        <button type="button" className={`btn ${compact ? "btn--small" : ""} btn--ghost`} onClick={() => input.current?.click()} disabled={upload.isPending}>
          {upload.isPending ? "Uploading…" : "Upload a .fit file"}
        </button>
      </div>
      {upload.isSuccess && (
        <span className="stack stack--tight">
          <span className="small" role="status">
            Uploaded {upload.data.name ?? "activity"}
            {upload.data.distanceM ? ` · ${formatDistance(upload.data.distanceM, units)}` : ""}.
          </span>
          <GarminAttribution activity={upload.data} />
        </span>
      )}
      <InlineError error={upload.error} />
    </div>
  );
}
