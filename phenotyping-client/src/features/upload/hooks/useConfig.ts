// useConfig — fetch, validate, and persist egg inference config.

import { useState, useCallback, useEffect } from "react";
import { getConfig, updateConfig } from "@/services/api";
import type { EggConfig } from "@/types/api";

export interface ValidationErrors {
  tile_size?: string;
  overlap?: string;
  confidence_threshold?: string;
  min_box_area?: string;
  edge_margin?: string;
  nms_iou_threshold?: string;
  batch_size?: string;
}

export interface UseConfigReturn {
  config: EggConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  validationErrors: ValidationErrors;
  isDirty: boolean;
  loadConfig: () => void;
  saveConfig: (updates: Partial<EggConfig>) => Promise<boolean>;
  resetConfig: () => void;
  clearError: () => void;
}

const DEFAULTS: EggConfig = {
  model: "models/egg_best.pt",
  device: "cpu",
  tile_size: 512,
  overlap: 0.5,
  confidence_threshold: 0.4,
  min_box_area: 100,
  dedup_mode: "center_zone",
  edge_margin: 3,
  nms_iou_threshold: 0.4,
  batch_size: 24,
};

export function useConfig(): UseConfigReturn {
  const [config, setConfig] = useState<EggConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<EggConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});

  const loadConfig = useCallback(() => {
    setLoading(true);
    setError(null);
    getConfig()
      .then((cfg) => {
        setConfig(cfg);
        setSavedConfig(cfg);
        setValidationErrors({});
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  function validate(values: Partial<EggConfig>): ValidationErrors {
    const errs: ValidationErrors = {};
    if (values.tile_size !== undefined) {
      if (!Number.isInteger(values.tile_size) || values.tile_size < 128 || values.tile_size > 2048) {
        errs.tile_size = "Must be an integer between 128 and 2048";
      }
    }
    if (values.overlap !== undefined) {
      if (values.overlap < 0 || values.overlap > 0.9) {
        errs.overlap = "Must be between 0.0 and 0.9";
      }
    }
    if (values.confidence_threshold !== undefined) {
      if (values.confidence_threshold < 0.01 || values.confidence_threshold > 1.0) {
        errs.confidence_threshold = "Must be between 0.01 and 1.0";
      }
    }
    if (values.min_box_area !== undefined) {
      if (!Number.isInteger(values.min_box_area) || values.min_box_area < 1) {
        errs.min_box_area = "Must be a positive integer";
      }
    }
    if (values.edge_margin !== undefined) {
      if (!Number.isInteger(values.edge_margin) || values.edge_margin < 0) {
        errs.edge_margin = "Must be a non-negative integer";
      }
    }
    if (values.nms_iou_threshold !== undefined) {
      if (values.nms_iou_threshold < 0.05 || values.nms_iou_threshold > 1.0) {
        errs.nms_iou_threshold = "Must be between 0.05 and 1.0";
      }
    }
    if (values.batch_size !== undefined) {
      if (!Number.isInteger(values.batch_size) || values.batch_size < 1 || values.batch_size > 64) {
        errs.batch_size = "Must be an integer between 1 and 64";
      }
    }
    return errs;
  }

  const saveConfig = useCallback(async (updates: Partial<EggConfig>): Promise<boolean> => {
    const errs = validate(updates);
    setValidationErrors(errs);
    if (Object.keys(errs).length > 0) return false;

    setSaving(true);
    setError(null);
    try {
      const updated = await updateConfig(updates);
      setConfig(updated);
      setSavedConfig(updated);
      setValidationErrors({});
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const resetConfig = useCallback(() => {
    if (savedConfig) {
      setConfig({ ...savedConfig });
      setValidationErrors({});
    }
  }, [savedConfig]);

  const clearError = useCallback(() => setError(null), []);

  const isDirty = config !== null && savedConfig !== null &&
    JSON.stringify(config) !== JSON.stringify(savedConfig);

  return {
    config,
    loading,
    saving,
    error,
    validationErrors,
    isDirty,
    loadConfig,
    saveConfig,
    resetConfig,
    clearError,
  };
}

export { DEFAULTS };